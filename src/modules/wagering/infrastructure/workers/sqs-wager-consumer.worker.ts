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
  IdempotencyKeyConflictError,
  InternalWagerTransactionError,
  InvalidWagerTransactionKindError,
  ProcessWagerTransactionUseCase,
  WagerWalletNotFoundError,
} from '../../application/use-cases/process-wager-transaction.use-case';
import {
  InvalidWagerAmountError,
  MissingWagerReferenceError,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction.entity';
import { MoneyProps, InvalidMoneyError } from '../../../../shared/domain/value-objects/money';
import { PostgresUnitOfWork } from '../persistence/repositories/postgres-uow';
import { canonicalJson, hashWagerPayload } from '../../application/hash-wager-payload';
import { qualifiedTableName } from '../persistence/qualified-table-name';

interface WagerQueueMessageData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey?: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

interface WagerQueueMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: WagerQueueMessageData;
}

class InvalidSqsWagerMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqsWagerMessageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function parseWagerQueueMessage(body: string, fallbackMessageId?: string): WagerQueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidSqsWagerMessageError('Message body is not valid JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    throw new InvalidSqsWagerMessageError('Message body must contain a data object');
  }

  const data = parsed.data;
  if (
    parsed.type !== 'WagerTransactionRequested' ||
    typeof parsed.occurredAt !== 'string' ||
    !isNonEmptyString(data.providerId) ||
    !isNonEmptyString(data.externalTransactionId) ||
    !isNonEmptyString(data.playerId) ||
    !isNonEmptyString(data.walletId) ||
    !isNonEmptyString(data.roundId) ||
    !isNonEmptyString(data.gameId) ||
    !Object.values(WagerTransactionKind).some((kind) => kind === data.kind) ||
    !isRecord(data.money) ||
    typeof data.money.amount !== 'string' ||
    typeof data.money.currency !== 'string' ||
    (data.idempotencyKey !== undefined && typeof data.idempotencyKey !== 'string') ||
    (data.referenceExternalTransactionId !== undefined && typeof data.referenceExternalTransactionId !== 'string') ||
    (data.correlationId !== undefined && typeof data.correlationId !== 'string')
  ) {
    throw new InvalidSqsWagerMessageError('Message body does not match the wager request contract');
  }

  const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : fallbackMessageId;
  if (!messageId) throw new InvalidSqsWagerMessageError('Message ID is missing');

  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: parsed.occurredAt,
    data: {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      ...(typeof data.idempotencyKey === 'string' ? { idempotencyKey: data.idempotencyKey } : {}),
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind as WagerTransactionKind,
      money: { amount: data.money.amount, currency: data.money.currency },
      ...(typeof data.referenceExternalTransactionId === 'string'
        ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
        : {}),
      ...(typeof data.correlationId === 'string' ? { correlationId: data.correlationId } : {}),
    },
  };
}

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
    try {
      const parsed = parseWagerQueueMessage(msg.Body, msg.MessageId);
      const { messageId, data } = parsed;
      const inboxPayloadHash = createHash('sha256').update(canonicalJson(parsed)).digest('hex');
      const payloadHash = hashWagerPayload({
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        walletId: data.walletId,
        playerId: data.playerId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
      });
      const fork = this.em.fork();

      await fork.transactional(async (txEm) => {
        const inboxTable = qualifiedTableName(txEm, 'inbox_messages');
        // 1. Inbox Deduplication: tenta inserir; se já existe, verifica se já foi processada
        await txEm.execute(
          `INSERT INTO ${inboxTable} (message_id, consumer_name, payload_hash, received_at)
           VALUES (?, ?, ?, NOW())
           ON CONFLICT (message_id, consumer_name) DO NOTHING`,
          [messageId, this.consumerName, inboxPayloadHash],
        );

        const [inboxRow] = await txEm.execute<Array<{ processed_at: Date | null; payload_hash: string }>>(
          `SELECT processed_at, payload_hash FROM ${inboxTable} WHERE message_id = ? AND consumer_name = ? FOR UPDATE`,
          [messageId, this.consumerName],
        );

        if (!inboxRow) throw new Error('Inbox row was not available after insert');
        if (inboxRow.payload_hash !== inboxPayloadHash) {
          throw new InvalidSqsWagerMessageError('Message ID was reused with a different payload');
        }
        if (inboxRow.processed_at) {
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
          ...(typeof data.correlationId === 'string' ? { correlationId: data.correlationId } : {}),
        });

        // 4. Marca a inbox como processada na mesma transação
        await txEm.execute(
          `UPDATE ${inboxTable} SET processed_at = NOW() WHERE message_id = ? AND consumer_name = ?`,
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
    } catch (error: unknown) {
      if (
        error instanceof InternalWagerTransactionError ||
        error instanceof IdempotencyKeyConflictError ||
        error instanceof InvalidWagerTransactionKindError ||
        error instanceof InvalidWagerAmountError ||
        error instanceof InvalidMoneyError ||
        error instanceof MissingWagerReferenceError ||
        error instanceof WagerWalletNotFoundError
      ) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Terminal wager validation error, acknowledging message: ${errorMessage}`);
        await this.sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );
        return;
      }

      const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');
      const retryDelaySeconds = error instanceof InvalidSqsWagerMessageError
        ? 0
        : Math.min(2 ** (Number.isFinite(receiveCount) && receiveCount > 0 ? receiveCount : 1), 300);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Message ${msg.MessageId ?? 'unknown'} failed and will be retried or moved to DLQ: ${errorMessage}`);
      await this.changeVisibility(msg, retryDelaySeconds);
    }
  }

  private async releaseVisibility(msg: Message): Promise<void> {
    await this.changeVisibility(msg, 0);
  }

  private async changeVisibility(msg: Message, visibilityTimeout: number): Promise<void> {
    if (!msg.ReceiptHandle) return;
    await this.sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: msg.ReceiptHandle,
        VisibilityTimeout: visibilityTimeout,
      }),
    );
  }
}
