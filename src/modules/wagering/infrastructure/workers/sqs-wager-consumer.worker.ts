import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash } from 'crypto';
import {
  InternalWagerTransactionError,
  InvalidWagerTransactionKindError,
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { InvalidWagerAmountError } from '../../domain/entities/wager-transaction.entity';
import { PostgresUnitOfWork } from '../persistence/repositories/postgres-uow';

@Injectable()
export class SqsWagerConsumerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumerWorker.name);
  private readonly queueUrl: string;
  private readonly consumerName = 'wagering-sqs-consumer';
  private isShuttingDown = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly em: EntityManager,
  ) {
    this.queueUrl =
      process.env.AWS_SQS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
  }

  onModuleInit() {
    this.logger.log('Starting SqsWagerConsumerWorker...');
    this.loopPromise = this.pollLoop();
  }

  async onModuleDestroy() {
    this.logger.log('Stopping SqsWagerConsumerWorker (SIGTERM received)...');
    this.isShuttingDown = true;
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.logger.log('SqsWagerConsumerWorker stopped cleanly.');
  }

  private async pollLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        // Long Polling de 5 segundos para reduzir CPU e chamadas vazias
        const response = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 5,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );

        const messages = response.Messages || [];
        for (const msg of messages) {
          if (this.isShuttingDown) {
            // Se recebeu SIGTERM no meio do lote, devolve a visibilidade imediatamente para outra instância assumir
            await this.releaseVisibility(msg);
            break;
          }
          await this.handleMessage(msg);
        }
      } catch (error) {
        if (!this.isShuttingDown) {
          this.logger.error('Error polling SQS queue', error);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  }

  async handleMessage(msg: Message): Promise<void> {
    if (!msg.Body || !msg.ReceiptHandle) return;

    const parsed = JSON.parse(msg.Body);
    const messageId: string = parsed.messageId || msg.MessageId!;
    const data = parsed.data;
    const payloadHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');

    const fork = this.em.fork();

    try {
      await fork.transactional(async (txEm) => {
        // 1. Inbox Deduplication: tenta inserir; se já existe, verifica se já foi processada
        await txEm.execute(
          `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at)
           VALUES (?, ?, ?, NOW())
           ON CONFLICT (message_id, consumer_name) DO NOTHING`,
          [messageId, this.consumerName, payloadHash],
        );

        const [inboxRow] = await txEm.execute<Array<{ processed_at: Date | null }>>(
          `SELECT processed_at FROM inbox_messages WHERE message_id = ? AND consumer_name = ? FOR UPDATE`,
          [messageId, this.consumerName],
        );

        if (inboxRow?.processed_at) {
          this.logger.debug(`Duplicate SQS message ignored via Inbox: ${messageId}`);
          return;
        }

        const useCase = new ProcessWagerTransactionUseCase(
          PostgresUnitOfWork.forCurrentTransaction(txEm),
        );

        // 3. Executa o mesmo caso de uso da API HTTP
        await useCase.execute({
          providerId: data.providerId,
          externalTransactionId: data.externalTransactionId,
          idempotencyKey: data.idempotencyKey || `${data.providerId}:${data.externalTransactionId}`,
          payloadHash,
          walletId: data.walletId,
          playerId: data.playerId,
          roundId: data.roundId,
          gameId: data.gameId,
          kind: data.kind,
          money: data.money,
          referenceExternalTransactionId: data.referenceExternalTransactionId,
        });

        // 4. Marca a inbox como processada na mesma transação
        await txEm.execute(
          `UPDATE inbox_messages SET processed_at = NOW() WHERE message_id = ? AND consumer_name = ?`,
          [messageId, this.consumerName],
        );
      });

      // 5. ACK na fila SOMENTE após o COMMIT bem-sucedido no PostgreSQL
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
    } catch (error: any) {
      // Se for erro de payload malformado/inválido, fazemos ACK para não ficar em loop infinito (ou enviamos para DLQ)
      if (
        error instanceof InternalWagerTransactionError ||
        error instanceof InvalidWagerTransactionKindError ||
        error instanceof InvalidWagerAmountError ||
        error.message?.includes('Invalid monetary') ||
        error.message?.includes('requires a reference')
      ) {
        this.logger.warn(`Permanent validation error on message ${messageId}, acknowledging to drop: ${error.message}`);
        await this.sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );
        return;
      }

      // Erros transitórios (ex: banco caiu temporariamente): NÃO fazemos ACK.
      // O SQS vai reentregar após o VisibilityTimeout e moverá para a DLQ após 3 falhas.
      this.logger.error(`Transient error processing SQS message ${messageId}, will retry: ${error.message}`);
    }
  }

  private async releaseVisibility(msg: Message): Promise<void> {
    if (!msg.ReceiptHandle) return;
    await this.sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: msg.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }
}
