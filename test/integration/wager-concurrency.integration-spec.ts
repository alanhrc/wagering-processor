import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { Migration20261115000000 } from '../../src/modules/wagering/infrastructure/persistence/migrations/Migration20261115000000';
import { Migration20261116000000 } from '../../src/modules/wagering/infrastructure/persistence/migrations/Migration20261116000000';
import { Migration20261117000000 } from '../../src/modules/wagering/infrastructure/persistence/migrations/Migration20261117000000';
import { Migration20261118000000 } from '../../src/modules/wagering/infrastructure/persistence/migrations/Migration20261118000000';

import { PostgresWalletRepository } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-wallet.repository';

import { CreateWalletUseCase } from '../../src/modules/wagering/application/use-cases/create-wallet.use-case';
import {
  IdempotencyKeyConflictError,
  ProcessWagerTransactionUseCase,
} from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/value-objects/money';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/entities/wager-transaction.entity';
import { WalletLedgerEntryOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wallet-ledger.orm-entity';
import { WalletOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wallet.orm-entity';
import { WagerTransactionOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wager-transaction.orm-entity';
import { PostgresUnitOfWork } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-uow';
import { createSqsClient } from '../../src/modules/wagering/infrastructure/messaging/sqs.client';
import { SqsEventPublisher } from '../../src/modules/wagering/infrastructure/messaging/sqs-event.publisher';
import { OutboxPublisherWorker } from '../../src/modules/wagering/infrastructure/workers/outbox-publisher.worker';
import { SqsWagerConsumerWorker } from '../../src/modules/wagering/infrastructure/workers/sqs-wager-consumer.worker';

describe('Wagering Concurrency & Integration Tests', () => {
  let orm: MikroORM | undefined;
  const dbName = process.env.DB_POSTGRES_NAME || 'wagering_db';
  const dbPort = parseInt(process.env.DB_POSTGRES_PORT || '5436');
  const keepTestSchema = process.env.KEEP_TEST_SCHEMA === 'true';
  const schemaName = keepTestSchema
    ? 'wagering_integration_audit'
    : `wagering_integration_${crypto.randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!orm) {
      orm = await MikroORM.init({
        ...config,
        entities: [WalletOrmEntity, WagerTransactionOrmEntity, WalletLedgerEntryOrmEntity],
        entitiesTs: [],
        metadataProvider: ReflectMetadataProvider,
        dbName: dbName,
        host: 'localhost',
        port: dbPort,
        schema: schemaName,
        migrations: {
          ...config.migrations,
          snapshot: false,
          migrationsList: [
            Migration20261115000000,
            Migration20261116000000,
            Migration20261117000000,
            Migration20261118000000,
          ],
        },
      });

      await orm.em.getConnection().execute(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
      await orm.migrator.up({ schema: schemaName });
    }
  });

  afterAll(async () => {
    if (orm) {
      try {
        if (!keepTestSchema) {
          await orm.em.getConnection().execute(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        }
      } finally {
        await orm.close(true);
      }
    }
  });

  // Helper para instanciar o Use Case com um EntityManager isolado por requisição
  const createUseCase = () => {
    const em = orm!.em.fork();
    return new ProcessWagerTransactionUseCase(new PostgresUnitOfWork(em));
  };

  const findOutboxEventTypes = async (walletId: string): Promise<string[]> => {
    const rows = await orm!.em.getConnection().execute<Array<{ event_type: string }>>(
      `SELECT event_type FROM "${schemaName}".outbox_messages WHERE aggregate_id = ?`,
      [walletId],
      'all',
    );
    return rows.map((row) => row.event_type).sort();
  };

  it('should process concurrent bets correctly: only one succeeds and leaves balance at 20.00 BRL', async () => {
    const setupEm = orm!.em.fork();
    const runId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    // 1. Criar carteira com 100.00 BRL
    const createdWallet = await new CreateWalletUseCase(new PostgresUnitOfWork(setupEm)).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = createdWallet.id;

    // 2. Cada chamada simultânea simula uma requisição/instância diferente (com seu próprio EM)
    const useCase1 = createUseCase();
    const useCase2 = createUseCase();

    const promise1 = useCase1.execute({
      providerId: 'provider-a',
      externalTransactionId: `${runId}-one`,
      idempotencyKey: `prov:${runId}-one`,
      payloadHash: 'hash1',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    });

    const promise2 = useCase2.execute({
      providerId: 'provider-a',
      externalTransactionId: `${runId}-two`,
      idempotencyKey: `prov:${runId}-two`,
      payloadHash: 'hash2',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    });

    const results = await Promise.all([promise1, promise2]);

    // 3. Validar resultados
    const processedCount = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
    const rejectedCount = results.filter((r) => r.status === WagerTransactionStatus.Rejected).length;

    expect(processedCount).toBe(1);
    expect(rejectedCount).toBe(1);

    // 4. Validar saldo final da carteira no banco
    const verifyEm = orm!.em.fork();
    const verifyWalletRepo = new PostgresWalletRepository(verifyEm);
    const finalWallet = await verifyWalletRepo.findById(walletId);
    expect(finalWallet?.balance.toString()).toBe('20.00');
    const ledgerEntries = await verifyEm.find(WalletLedgerEntryOrmEntity, { walletId });
    expect(ledgerEntries).toHaveLength(2);
    const reconstructedBalance = ledgerEntries.reduce((balance, entry) => {
      const money = Money.from({ amount: entry.amount, currency: entry.currency });
      return entry.direction === 'CREDIT' ? balance.add(money) : balance.subtract(money);
    }, Money.zero('BRL'));
    expect(finalWallet?.balance.equals(reconstructedBalance)).toBe(true);
    expect(await findOutboxEventTypes(walletId)).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
  });

  it('should apply one debit when the same wager is delivered 50 times concurrently', async () => {
    const setupEm = orm!.em.fork();
    const playerId = crypto.randomUUID();
    const createdWallet = await new CreateWalletUseCase(new PostgresUnitOfWork(setupEm)).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = crypto.randomUUID();
    const command = {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'same-payload-hash',
      walletId: createdWallet.id,
      playerId,
      roundId: 'round-50',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => createUseCase().execute(command)),
    );

    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);

    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(createdWallet.id);
    expect(finalWallet?.balance.toString()).toBe('90.00');
    expect(await verifyEm.count(WagerTransactionOrmEntity, { idempotencyKey: command.idempotencyKey })).toBe(1);
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: createdWallet.id })).toBe(2);
    expect(await findOutboxEventTypes(createdWallet.id)).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
  });

  it('should reject an idempotency key reused with a different payload', async () => {
    const setupEm = orm!.em.fork();
    const playerId = crypto.randomUUID();
    const createdWallet = await new CreateWalletUseCase(new PostgresUnitOfWork(setupEm)).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = crypto.randomUUID();
    const command = {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'original-payload-hash',
      walletId: createdWallet.id,
      playerId,
      roundId: 'round-conflict',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };

    await createUseCase().execute(command);
    await expect(
      createUseCase().execute({ ...command, payloadHash: 'different-payload-hash' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(createdWallet.id);
    expect(finalWallet?.balance.toString()).toBe('90.00');
    expect(await verifyEm.count(WagerTransactionOrmEntity, { idempotencyKey: command.idempotencyKey })).toBe(1);
  });

  it('should publish pending outbox messages once with concurrent publishers', async () => {
    const sqsClient: SQSClient = createSqsClient();
    const queueName = `wager-events-integration-${crypto.randomUUID().replaceAll('-', '')}.fifo`;
    const previousQueueUrl = process.env.AWS_SQS_EVENTS_QUEUE_URL;
    let queueUrl: string | undefined;

    try {
      const queue = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
          },
        }),
      );
      queueUrl = queue.QueueUrl;
      if (!queueUrl) throw new Error('LocalStack did not return the integration queue URL');
      process.env.AWS_SQS_EVENTS_QUEUE_URL = queueUrl;

      const pendingRows = await orm!.em.getConnection().execute<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "${schemaName}".outbox_messages WHERE published_at IS NULL`,
        [],
        'all',
      );
      const expectedMessageCount = Number(pendingRows[0]?.count ?? 0);
      const publisher = new SqsEventPublisher(sqsClient);
      const firstWorker = new OutboxPublisherWorker(orm!.em.fork(), publisher);
      const secondWorker = new OutboxPublisherWorker(orm!.em.fork(), publisher);

      const processedCounts = await Promise.all([
        firstWorker.processBatch(100),
        secondWorker.processBatch(100),
      ]);
      expect(processedCounts.reduce((total, count) => total + count, 0)).toBe(expectedMessageCount);

      const publishedRows = await orm!.em.getConnection().execute<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "${schemaName}".outbox_messages WHERE published_at IS NOT NULL`,
        [],
        'all',
      );
      expect(Number(publishedRows[0]?.count ?? 0)).toBe(expectedMessageCount);

      let receivedMessageCount = 0;
      while (receivedMessageCount < expectedMessageCount) {
        const response = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        const messages = response.Messages ?? [];
        if (messages.length === 0) break;
        receivedMessageCount += messages.length;

        await Promise.all(
          messages.flatMap((message) =>
            message.ReceiptHandle
              ? [
                  sqsClient.send(
                    new DeleteMessageCommand({
                      QueueUrl: queueUrl,
                      ReceiptHandle: message.ReceiptHandle,
                    }),
                  ),
                ]
              : [],
          ),
        );
      }
      expect(receivedMessageCount).toBe(expectedMessageCount);
    } finally {
      if (previousQueueUrl === undefined) {
        delete process.env.AWS_SQS_EVENTS_QUEUE_URL;
      } else {
        process.env.AWS_SQS_EVENTS_QUEUE_URL = previousQueueUrl;
      }
      if (queueUrl) {
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
      sqsClient.destroy();
    }
  });

  it('should deduplicate redelivered SQS messages through the persistent inbox', async () => {
    const sqsClient: SQSClient = createSqsClient();
    const queueName = `wager-transactions-integration-${crypto.randomUUID().replaceAll('-', '')}.fifo`;
    const previousQueueUrl = process.env.AWS_SQS_QUEUE_URL;
    let queueUrl: string | undefined;

    try {
      const queue = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
          },
        }),
      );
      queueUrl = queue.QueueUrl;
      if (!queueUrl) throw new Error('LocalStack did not return the integration queue URL');
      process.env.AWS_SQS_QUEUE_URL = queueUrl;

      const playerId = crypto.randomUUID();
      const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const externalTransactionId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const data = {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-redelivery',
        gameId: 'slot-hot',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      };
      const body = JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data,
      });

      await Promise.all(
        [0, 1].map((index) =>
          sqsClient.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: body,
              MessageGroupId: wallet.id,
              MessageDeduplicationId: `${messageId}-${index}`,
            }),
          ),
        ),
      );

      const response = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      const messages = response.Messages ?? [];
      expect(messages).toHaveLength(2);

      const consumer = new SqsWagerConsumerWorker(sqsClient, orm!.em.fork());
      await Promise.all(messages.map((message) => consumer.handleMessage(message)));

      const verifyEm = orm!.em.fork();
      const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
      expect(finalWallet?.balance.toString()).toBe('90.00');
      expect(await verifyEm.count(WagerTransactionOrmEntity, { idempotencyKey: data.idempotencyKey })).toBe(1);
      expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(2);

      const inboxRows = await orm!.em.getConnection().execute<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "${schemaName}".inbox_messages
         WHERE message_id = ? AND consumer_name = ? AND processed_at IS NOT NULL`,
        [messageId, 'wagering-sqs-consumer'],
        'all',
      );
      expect(Number(inboxRows[0]?.count ?? 0)).toBe(1);
    } finally {
      if (previousQueueUrl === undefined) {
        delete process.env.AWS_SQS_QUEUE_URL;
      } else {
        process.env.AWS_SQS_QUEUE_URL = previousQueueUrl;
      }
      if (queueUrl) {
        await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
      sqsClient.destroy();
    }
  });
});
