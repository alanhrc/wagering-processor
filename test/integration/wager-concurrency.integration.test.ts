import { rejects } from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CreateQueueCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
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
import { Migration20261120000000 } from '../../src/modules/wagering/infrastructure/persistence/migrations/Migration20261120000000';
import { Migration20261119000000 } from '../../src/modules/wagering/infrastructure/persistence/migrations/Migration20261119000000';

import { PostgresWalletRepository } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-wallet.repository';

import { CreateWalletUseCase } from '../../src/modules/wagering/application/use-cases/create-wallet.use-case';
import {
  IdempotencyKeyConflictError,
  ProcessWagerTransactionUseCase,
} from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/value-objects/money';
import {
  FailureCode,
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
import { PendingReferenceWorker } from '../../src/modules/wagering/infrastructure/workers/pending-reference.worker';
import { ReconcileWalletUseCase } from '../../src/modules/wagering/application/use-cases/reconcile-wallet.use-case';
import { GetWalletQueriesUseCase } from '../../src/modules/wagering/application/use-cases/get-wallet-queries.use-case';
import { GetWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/get-wager-transaction.use-case';
import { HealthController } from '../../src/modules/wagering/presentation/http/health.controller';

describe('Wagering Concurrency & Integration Tests', () => {
  let orm: MikroORM | undefined;
  const dbName = process.env.DB_POSTGRES_NAME || 'wagering_db';
  const dbPort = parseInt(process.env.DB_POSTGRES_PORT || '5436');
  const keepTestSchema = process.env.KEEP_TEST_SCHEMA === 'true';
  const schemaName = `wagering_integration_${crypto.randomUUID().replaceAll('-', '')}`;
  const createOrmConnection = (schema = schemaName) =>
    MikroORM.init({
      ...config,
      entities: [WalletOrmEntity, WagerTransactionOrmEntity, WalletLedgerEntryOrmEntity],
      entitiesTs: [],
      metadataProvider: ReflectMetadataProvider,
      dbName,
      host: 'localhost',
      port: dbPort,
      schema,
      migrations: {
        ...config.migrations,
        snapshot: false,
        migrationsList: [
          Migration20261115000000,
          Migration20261116000000,
          Migration20261117000000,
          Migration20261118000000,
          Migration20261119000000,
          Migration20261120000000,
        ],
      },
    });

  beforeAll(async () => {
    if (!orm) {
      process.stdout.write(`[integration] schema=${schemaName} retained=${keepTestSchema}\n`);
      orm = await createOrmConnection();

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

  it('should serialize three independent Bun processes competing for the same wallet', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const runId = crypto.randomUUID();
    const fixturePath = fileURLToPath(new URL('../fixtures/process-wager-command.ts', import.meta.url));
    const outcomes = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(
            'bun',
            ['run', fixturePath, schemaName, wallet.id, playerId, `${runId}-${index}`],
            { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, stdout, stderr }));
        }),
      ),
    );
    const failedProcesses = outcomes.filter((outcome) => outcome.code !== 0);
    if (failedProcesses.length > 0) {
      throw new Error(failedProcesses.map((outcome) => outcome.stderr || outcome.stdout).join('\n'));
    }
    const results = outcomes.map((outcome) => {
      if (outcome.stderr) throw new Error(outcome.stderr);
      return JSON.parse(outcome.stdout.trim()) as { status: string };
    });

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.status === WagerTransactionStatus.Rejected)).toHaveLength(2);

    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
    expect(finalWallet?.balance.toString()).toBe('40.00');
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(2);
  });

  it('should process operations on different wallets in parallel', async () => {
    const players = [crypto.randomUUID(), crypto.randomUUID()];
    const wallets = await Promise.all(
      players.map((playerId) =>
        new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      ),
    );

    const results = await Promise.all(
      wallets.map((wallet, index) => {
        const externalTransactionId = `${crypto.randomUUID()}-${index}`;
        return createUseCase().execute({
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          payloadHash: `wallet-payload-${index}`,
          walletId: wallet.id,
          playerId: players[index]!,
          roundId: 'round-distinct-wallets',
          gameId: 'slot-hot',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        });
      }),
    );

    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    const verifyEm = orm!.em.fork();
    const finalWallets = await Promise.all(wallets.map((wallet) => new PostgresWalletRepository(verifyEm).findById(wallet.id)));
    expect(finalWallets.map((wallet) => wallet?.balance.toString())).toEqual(['20.00', '20.00']);
  });

  it('should allow only one total reversal of a processed wager', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const referenceExternalTransactionId = crypto.randomUUID();
    const reference = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: referenceExternalTransactionId,
      idempotencyKey: `provider-a:${referenceExternalTransactionId}`,
      payloadHash: 'original-wager',
      walletId: wallet.id,
      playerId,
      roundId: 'round-reversal',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
    const refundId = crypto.randomUUID();
    const refund = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: refundId,
      idempotencyKey: `provider-a:${refundId}`,
      payloadHash: 'refund-payload',
      walletId: wallet.id,
      playerId,
      roundId: 'round-reversal',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId,
    });
    const rollbackId = crypto.randomUUID();
    const rollback = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: rollbackId,
      idempotencyKey: `provider-a:${rollbackId}`,
      payloadHash: 'rollback-payload',
      walletId: wallet.id,
      playerId,
      roundId: 'round-reversal',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId,
    });

    expect(reference.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.DuplicateTransaction);

    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
    expect(finalWallet?.balance.toString()).toBe('100.00');
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(3);
  });

  it('should preserve the wallet balance currency when rejecting a currency mismatch', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = crypto.randomUUID();
    const result = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'currency-mismatch',
      walletId: wallet.id,
      playerId,
      roundId: 'round-currency-mismatch',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'USD' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const replay = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'currency-mismatch',
      walletId: wallet.id,
      playerId,
      roundId: 'round-currency-mismatch',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'USD' },
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
    expect(finalWallet?.balance.toString()).toBe('100.00');
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(1);
  });

  it('should reject a rollback that would make the wallet balance negative with a distinct failure code', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const winId = crypto.randomUUID();
    const win = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: winId,
      idempotencyKey: `provider-a:${winId}`,
      payloadHash: 'win-to-rollback',
      walletId: wallet.id,
      playerId,
      roundId: 'round-reversal-insufficient',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });
    const betId = crypto.randomUUID();
    const bet = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: betId,
      idempotencyKey: `provider-a:${betId}`,
      payloadHash: 'spend-win-balance',
      walletId: wallet.id,
      playerId,
      roundId: 'round-reversal-insufficient',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });
    const rollbackId = crypto.randomUUID();
    const rollback = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: rollbackId,
      idempotencyKey: `provider-a:${rollbackId}`,
      payloadHash: 'rollback-spent-win',
      walletId: wallet.id,
      playerId,
      roundId: 'round-reversal-insufficient',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: winId,
    });

    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
    expect(finalWallet?.balance.toString()).toBe('0.00');
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(2);
  });

  it('should process a reversal after its referenced wager arrives', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const referenceExternalTransactionId = crypto.randomUUID();
    const reversalExternalTransactionId = crypto.randomUUID();
    const reversalCommand = {
      providerId: 'provider-a',
      externalTransactionId: reversalExternalTransactionId,
      idempotencyKey: `provider-a:${reversalExternalTransactionId}`,
      payloadHash: 'out-of-order-reversal',
      walletId: wallet.id,
      playerId,
      roundId: 'round-out-of-order',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId,
    };

    const pending = await createUseCase().execute(reversalCommand);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: referenceExternalTransactionId,
      idempotencyKey: `provider-a:${referenceExternalTransactionId}`,
      payloadHash: 'late-reference',
      walletId: wallet.id,
      playerId,
      roundId: 'round-out-of-order',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
    await orm!.em.getConnection().execute(
      `UPDATE "${schemaName}".wager_transactions SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ?`,
      [pending.transactionId],
    );

    const worker = new PendingReferenceWorker(orm!.em.fork(), createUseCase());
    worker.onModuleInit();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    } finally {
      await worker.onModuleDestroy();
    }

    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
    const processed = await new GetWagerTransactionUseCase(new PostgresUnitOfWork(verifyEm)).byId(pending.transactionId);
    expect(processed.status).toBe(WagerTransactionStatus.Processed);
    expect(finalWallet?.balance.toString()).toBe('100.00');
    const ledgerEntries = await verifyEm.find(WalletLedgerEntryOrmEntity, { walletId: wallet.id });
    const reconstructedBalance = ledgerEntries.reduce((balance, entry) => {
      const money = Money.from({ amount: entry.amount, currency: entry.currency });
      return entry.direction === 'CREDIT' ? balance.add(money) : balance.subtract(money);
    }, Money.zero('BRL'));
    expect(finalWallet?.balance.equals(reconstructedBalance)).toBe(true);
    expect(await findOutboxEventTypes(wallet.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
  });

  it('should reject a pending reference after exhausting its retry limit', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = crypto.randomUUID();
    const command = {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'reference-never-arrives',
      walletId: wallet.id,
      playerId,
      roundId: 'round-reference-expiry',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: crypto.randomUUID(),
    };

    const pending = await createUseCase().execute(command);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    await orm!.em.getConnection().execute(
      `UPDATE "${schemaName}".wager_transactions
       SET attempts = 9, next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ?`,
      [pending.transactionId],
    );

    const expired = await createUseCase().execute(command);
    expect(expired.status).toBe(WagerTransactionStatus.Rejected);
    expect(expired.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await findOutboxEventTypes(wallet.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceChanged',
    ]);
  });

  it('should enforce wallet and immutable ledger invariants in PostgreSQL', async () => {
    const playerId = crypto.randomUUID();
    const createWallet = new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork()));
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    await rejects(
      async () => createWallet.execute({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } }),
    );
    await rejects(
      async () => orm!.em.getConnection().execute(
        `UPDATE "${schemaName}".wallets SET balance = '-1.00' WHERE id = ?`,
        [wallet.id],
      ),
    );

    const ledger = await orm!.em.fork().findOne(WalletLedgerEntryOrmEntity, { walletId: wallet.id });
    if (!ledger) throw new Error('Opening wallet did not create its ledger entry');
    await rejects(
      async () => orm!.em.getConnection().execute(
        `UPDATE "${schemaName}".wallet_ledger_entries SET amount = '99.00' WHERE id = ?`,
        [ledger.id],
      ),
    );

    const lossId = crypto.randomUUID();
    await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId: lossId,
      idempotencyKey: `provider-a:${lossId}`,
      payloadHash: 'loss-without-ledger',
      walletId: wallet.id,
      playerId,
      roundId: 'round-ledger-constraints',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Loss,
      money: { amount: '10.00', currency: 'BRL' },
    });
    await rejects(
      async () => orm!.em.getConnection().execute(
        `INSERT INTO "${schemaName}".wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         VALUES (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '95.00')`,
        [crypto.randomUUID(), wallet.id, lossId],
      ),
    );

    const verifyEm = orm!.em.fork();
    const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
    expect(finalWallet?.balance.toString()).toBe('100.00');
    expect(finalWallet?.version).toBe(1);
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(1);
  });

  it('should roll all migrations down and reapply them on an isolated schema', async () => {
    const migrationSchema = `wagering_migrations_${crypto.randomUUID().replaceAll('-', '')}`;
    const migrationOrm = await createOrmConnection(migrationSchema);

    try {
      await migrationOrm.em.getConnection().execute(`CREATE SCHEMA "${migrationSchema}"`);
      await migrationOrm.migrator.up({ schema: migrationSchema });
      expect(await migrationOrm.migrator.getExecuted({ schema: migrationSchema })).toHaveLength(6);
      const authTable = await migrationOrm.em.getConnection().execute<Array<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name = 'auth_users'`,
        [migrationSchema],
        'all',
      );
      expect(authTable).toHaveLength(0);

      await migrationOrm.migrator.down({ schema: migrationSchema, to: 0 });
      expect(await migrationOrm.migrator.getExecuted({ schema: migrationSchema })).toHaveLength(0);
      const tablesAfterDown = await migrationOrm.em.getConnection().execute<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM information_schema.tables
         WHERE table_schema = ? AND table_name = 'wallets'`,
        [migrationSchema],
        'all',
      );
      expect(tablesAfterDown[0]?.count).toBe(0);

      await migrationOrm.migrator.up({ schema: migrationSchema });
      expect(await migrationOrm.migrator.getExecuted({ schema: migrationSchema })).toHaveLength(6);
    } finally {
      try {
        await migrationOrm.em.getConnection().execute(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
      } finally {
        await migrationOrm.close(true);
      }
    }
  });

  it('should reconstruct committed wallet and ledger state through a restarted ORM client', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = crypto.randomUUID();
    await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'restart-recovery',
      walletId: wallet.id,
      playerId,
      roundId: 'round-restart',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });

    const restartedOrm = await createOrmConnection();
    try {
      const verifyEm = restartedOrm.em.fork();
      const recoveredWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
      const entries = await verifyEm.find(WalletLedgerEntryOrmEntity, { walletId: wallet.id });
      const rebuiltBalance = entries.reduce((balance, entry) => {
        const money = Money.from({ amount: entry.amount, currency: entry.currency });
        return entry.direction === 'CREDIT' ? balance.add(money) : balance.subtract(money);
      }, Money.zero('BRL'));

      expect(recoveredWallet?.balance.toString()).toBe('70.00');
      expect(recoveredWallet?.balance.equals(rebuiltBalance)).toBe(true);
      expect(await verifyEm.count(WagerTransactionOrmEntity, { externalTransactionId })).toBe(1);
    } finally {
      await restartedOrm.close(true);
    }
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
    await rejects(
      async () => createUseCase().execute({ ...command, payloadHash: 'different-payload-hash' }),
      IdempotencyKeyConflictError,
    );

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

  it('should recover an outbox event whose previous publisher lease expired', async () => {
    const sqsClient = createSqsClient();
    const queueName = `wager-outbox-recovery-${crypto.randomUUID().replaceAll('-', '')}.fifo`;
    const previousQueueUrl = process.env.AWS_SQS_EVENTS_QUEUE_URL;
    let queueUrl: string | undefined;

    try {
      const queue = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }),
      );
      queueUrl = queue.QueueUrl;
      if (!queueUrl) throw new Error('LocalStack did not return the outbox recovery queue URL');
      process.env.AWS_SQS_EVENTS_QUEUE_URL = queueUrl;

      const playerId = crypto.randomUUID();
      const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const [event] = await orm!.em.getConnection().execute<Array<{ id: string; payload: unknown }>>(
        `SELECT id, payload FROM "${schemaName}".outbox_messages
         WHERE aggregate_id = ? AND published_at IS NULL ORDER BY occurred_at ASC LIMIT 1`,
        [wallet.id],
        'all',
      );
      if (!event) throw new Error('Wallet opening did not create an outbox event');
      await orm!.em.getConnection().execute(
        `UPDATE "${schemaName}".outbox_messages
         SET occurred_at = '1970-01-01T00:00:00Z', lock_token = ?, locked_until = NOW() - INTERVAL '1 second'
         WHERE id = ?`,
        [crypto.randomUUID(), event.id],
      );

      const publisher = new SqsEventPublisher(sqsClient);
      const worker = new OutboxPublisherWorker(orm!.em.fork(), publisher);
      expect(await worker.processBatch(1)).toBe(1);

      const [publishedEvent] = await orm!.em.getConnection().execute<Array<{ published_at: Date | null; lock_token: string | null }>>(
        `SELECT published_at, lock_token FROM "${schemaName}".outbox_messages WHERE id = ?`,
        [event.id],
        'all',
      );
      expect(publishedEvent?.published_at).toBeTruthy();
      expect(publishedEvent?.lock_token).toBeNull();

      const messages = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      expect(messages.Messages).toHaveLength(1);
      const payload: unknown = JSON.parse(messages.Messages?.[0]?.Body ?? 'null');
      expect(payload).toMatchObject({ eventId: expect.any(String), aggregateId: wallet.id });
    } finally {
      if (previousQueueUrl === undefined) delete process.env.AWS_SQS_EVENTS_QUEUE_URL;
      else process.env.AWS_SQS_EVENTS_QUEUE_URL = previousQueueUrl;
      if (queueUrl) await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      sqsClient.destroy();
    }
  });

  it('should record an outbox publish failure and schedule a retry', async () => {
    const sqsClient = createSqsClient();
    const previousQueueUrl = process.env.AWS_SQS_EVENTS_QUEUE_URL;

    try {
      const playerId = crypto.randomUUID();
      const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const [event] = await orm!.em.getConnection().execute<Array<{ id: string }>>(
        `SELECT id FROM "${schemaName}".outbox_messages
         WHERE aggregate_id = ? AND published_at IS NULL ORDER BY occurred_at ASC LIMIT 1`,
        [wallet.id],
        'all',
      );
      if (!event) throw new Error('Wallet opening did not create an outbox event');
      await orm!.em.getConnection().execute(
        `UPDATE "${schemaName}".outbox_messages
         SET occurred_at = '1970-01-01T00:00:00Z', next_attempt_at = NULL, attempts = 0
         WHERE id = ?`,
        [event.id],
      );
      process.env.AWS_SQS_EVENTS_QUEUE_URL = 'http://localhost:4566/000000000000/nonexistent-events-queue.fifo';

      const worker = new OutboxPublisherWorker(orm!.em.fork(), new SqsEventPublisher(sqsClient));
      expect(await worker.processBatch(1)).toBe(1);

      const [retriedEvent] = await orm!.em.getConnection().execute<Array<{ attempts: number; next_attempt_at: Date | null; published_at: Date | null }>>(
        `SELECT attempts, next_attempt_at, published_at FROM "${schemaName}".outbox_messages WHERE id = ?`,
        [event.id],
        'all',
      );
      expect(retriedEvent?.attempts).toBe(1);
      expect(retriedEvent?.next_attempt_at).toBeTruthy();
      expect(retriedEvent?.published_at).toBeNull();
    } finally {
      if (previousQueueUrl === undefined) delete process.env.AWS_SQS_EVENTS_QUEUE_URL;
      else process.env.AWS_SQS_EVENTS_QUEUE_URL = previousQueueUrl;
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
      const occurredAt = new Date().toISOString();
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
        occurredAt,
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

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt,
            data: { ...data, money: { amount: '20.00', currency: 'BRL' } },
          }),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: `${messageId}-changed-payload`,
        }),
      );
      const changedDelivery = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      const changedMessage = changedDelivery.Messages?.[0];
      if (!changedMessage) throw new Error('LocalStack did not return the changed-payload message');
      await consumer.handleMessage(changedMessage);

      const afterChangedPayloadEm = orm!.em.fork();
      const walletAfterChangedPayload = await new PostgresWalletRepository(afterChangedPayloadEm).findById(wallet.id);
      expect(walletAfterChangedPayload?.balance.toString()).toBe('90.00');
      expect(await afterChangedPayloadEm.count(WagerTransactionOrmEntity, { idempotencyKey: data.idempotencyKey })).toBe(1);
      expect(await afterChangedPayloadEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(2);
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

  it('should roll back inbox and financial writes when the outbox insert fails', async () => {
    const sqsClient = createSqsClient();
    const queueName = `wager-atomicity-${crypto.randomUUID().replaceAll('-', '')}.fifo`;
    const previousQueueUrl = process.env.AWS_SQS_QUEUE_URL;
    let queueUrl: string | undefined;
    let constraintCreated = false;

    try {
      const queue = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' },
        }),
      );
      queueUrl = queue.QueueUrl;
      if (!queueUrl) throw new Error('LocalStack did not return the atomicity queue URL');
      process.env.AWS_SQS_QUEUE_URL = queueUrl;

      const playerId = crypto.randomUUID();
      const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      await orm!.em.getConnection().execute(
        `ALTER TABLE "${schemaName}".outbox_messages
         ADD CONSTRAINT ck_test_reject_outbox CHECK (false) NOT VALID`,
      );
      constraintCreated = true;

      const externalTransactionId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const body = JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round-atomicity',
          gameId: 'slot-hot',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: messageId,
        }),
      );
      const received = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      const message = received.Messages?.[0];
      if (!message) throw new Error('LocalStack did not return the atomicity test message');

      await new SqsWagerConsumerWorker(sqsClient, orm!.em.fork()).handleMessage(message);

      const verifyEm = orm!.em.fork();
      const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
      expect(finalWallet?.balance.toString()).toBe('100.00');
      expect(await verifyEm.count(WagerTransactionOrmEntity, { externalTransactionId })).toBe(0);
      expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(1);
      const inboxRows = await orm!.em.getConnection().execute<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "${schemaName}".inbox_messages WHERE message_id = ?`,
        [messageId],
        'all',
      );
      expect(Number(inboxRows[0]?.count ?? 0)).toBe(0);

      await sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );

      const redelivered = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      expect(redelivered.Messages).toHaveLength(1);
    } finally {
      if (constraintCreated) {
        await orm!.em.getConnection().execute(
          `ALTER TABLE "${schemaName}".outbox_messages DROP CONSTRAINT IF EXISTS ck_test_reject_outbox`,
        );
      }
      if (previousQueueUrl === undefined) delete process.env.AWS_SQS_QUEUE_URL;
      else process.env.AWS_SQS_QUEUE_URL = previousQueueUrl;
      if (queueUrl) await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      sqsClient.destroy();
    }
  });

  it('should not duplicate financial effects when the commit succeeds but the SQS ack fails', async () => {
    const sqsClient = createSqsClient();
    const queueName = `wager-ack-recovery-${crypto.randomUUID().replaceAll('-', '')}.fifo`;
    const previousQueueUrl = process.env.AWS_SQS_QUEUE_URL;
    let queueUrl: string | undefined;
    let failNextAck = true;

    try {
      const queue = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' },
        }),
      );
      queueUrl = queue.QueueUrl;
      if (!queueUrl) throw new Error('LocalStack did not return the ack recovery queue URL');
      process.env.AWS_SQS_QUEUE_URL = queueUrl;

      const playerId = crypto.randomUUID();
      const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const externalTransactionId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const body = JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round-ack-recovery',
          gameId: 'slot-hot',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: messageId,
        }),
      );
      const firstDelivery = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      const firstMessage = firstDelivery.Messages?.[0];
      if (!firstMessage) throw new Error('LocalStack did not return the first delivery');

      const failingAckClient = {
        send: async (command: DeleteMessageCommand | ChangeMessageVisibilityCommand) => {
          if (command instanceof DeleteMessageCommand && failNextAck) {
            failNextAck = false;
            throw new Error('Simulated process loss after database commit');
          }
          return command instanceof DeleteMessageCommand ? sqsClient.send(command) : sqsClient.send(command);
        },
      } as unknown as SQSClient;
      await new SqsWagerConsumerWorker(failingAckClient, orm!.em.fork()).handleMessage(firstMessage);

      const afterCommitEm = orm!.em.fork();
      expect(await afterCommitEm.count(WagerTransactionOrmEntity, { externalTransactionId })).toBe(1);
      const committedWallet = await new PostgresWalletRepository(afterCommitEm).findById(wallet.id);
      expect(committedWallet?.balance.toString()).toBe('90.00');

      const redelivery = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 3 }),
      );
      const redeliveredMessage = redelivery.Messages?.[0];
      if (!redeliveredMessage) throw new Error('LocalStack did not redeliver the unacknowledged message');
      await new SqsWagerConsumerWorker(sqsClient, orm!.em.fork()).handleMessage(redeliveredMessage);
      const afterAck = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      expect(afterAck.Messages ?? []).toHaveLength(0);

      const verifyEm = orm!.em.fork();
      const finalWallet = await new PostgresWalletRepository(verifyEm).findById(wallet.id);
      expect(finalWallet?.balance.toString()).toBe('90.00');
      expect(await verifyEm.count(WagerTransactionOrmEntity, { externalTransactionId })).toBe(1);
      expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(2);
      const inboxRows = await orm!.em.getConnection().execute<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count FROM "${schemaName}".inbox_messages
         WHERE message_id = ? AND consumer_name = ? AND processed_at IS NOT NULL`,
        [messageId, 'wagering-sqs-consumer'],
        'all',
      );
      expect(Number(inboxRows[0]?.count ?? 0)).toBe(1);
    } finally {
      if (previousQueueUrl === undefined) delete process.env.AWS_SQS_QUEUE_URL;
      else process.env.AWS_SQS_QUEUE_URL = previousQueueUrl;
      if (queueUrl) await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      sqsClient.destroy();
    }
  });

  it('should survive SIGKILL after commit before ACK and recover in a new Bun process', async () => {
    const sqs = createSqsClient();
    let queueUrl: string | undefined;
    const children: ReturnType<typeof spawn>[] = [];
    const startWorker = (mode: string) => {
      const child = spawn('bun', [fileURLToPath(new URL('../fixtures/sqs-crash-worker.ts', import.meta.url)), schemaName, queueUrl!, mode], {
        env: { ...process.env, AWS_SQS_QUEUE_URL: queueUrl! },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let output = '';
      let errors = '';
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      });
      const marker = new Promise<void>((resolveMarker, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker ${mode} timed out: ${errors}`)), 15000);
        child.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes(mode === 'crash' ? 'COMMITTED_BEFORE_ACK' : 'WORKER_COMPLETED')) {
            clearTimeout(timer);
            resolveMarker();
          }
        });
        child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (!output.includes(mode === 'crash' ? 'COMMITTED_BEFORE_ACK' : 'WORKER_COMPLETED')) {
            reject(new Error(`Worker ${mode} exited with ${code}: ${errors}`));
          }
        });
      });
      return { child, marker, exited };
    };
    try {
      const created = await sqs.send(new CreateQueueCommand({
        QueueName: `wager-sigkill-${crypto.randomUUID().replaceAll('-', '')}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2' },
      }));
      queueUrl = created.QueueUrl;
      if (!queueUrl) throw new Error('Missing crash-test queue URL');
      const playerId = crypto.randomUUID();
      const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
        playerId, initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const messageId = crypto.randomUUID();
      const externalTransactionId = crypto.randomUUID();
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
          data: { providerId: 'provider-crash', externalTransactionId, playerId, walletId: wallet.id,
            roundId: 'crash-round', gameId: 'crash-game', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } },
        }),
      }));
      const first = startWorker('crash');
      await first.marker;
      const committed = await new PostgresWalletRepository(orm!.em.fork()).findById(wallet.id);
      expect(committed?.balance.toString()).toBe('90.00');
      const outboxCount = async () => {
        const rows = await orm!.em.getConnection().execute<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count FROM "${schemaName}".outbox_messages WHERE aggregate_id = ?`, [wallet.id], 'all',
        );
        return rows[0]?.count;
      };
      const committedOutboxCount = await outboxCount();
      first.child.kill('SIGKILL');
      expect((await first.exited).signal).toBe('SIGKILL');
      const second = startWorker('recover');
      await second.marker;
      expect((await second.exited).code).toBe(0);
      expect(await orm!.em.fork().count(WagerTransactionOrmEntity, { externalTransactionId })).toBe(1);
      expect(await orm!.em.fork().count(WalletLedgerEntryOrmEntity, { walletId: wallet.id })).toBe(2);
      expect(await outboxCount()).toBe(committedOutboxCount);
      const inbox = await orm!.em.getConnection().execute<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM "${schemaName}".inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL`, [messageId], 'all',
      );
      expect(inbox[0]?.count).toBe(1);
      const reconciliation = await new ReconcileWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute(wallet.id);
      expect(reconciliation.consistent).toBe(true);
      expect(reconciliation.storedBalance.amount).toBe('90.00');
      const remaining = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }));
      expect(remaining.Messages ?? []).toHaveLength(0);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const stopped = new Promise<void>((resolveStop) => child.once('exit', () => resolveStop()));
          child.kill('SIGKILL');
          await stopped;
        }
      }
      if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      sqs.destroy();
    }
  }, 30000);

  it('should move a permanently malformed SQS message to the configured DLQ', async () => {
    const sqsClient = createSqsClient();
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const deadLetterQueueName = `wager-dlq-test-${suffix}.fifo`;
    const sourceQueueName = `wager-source-test-${suffix}.fifo`;
    const previousQueueUrl = process.env.AWS_SQS_QUEUE_URL;
    let deadLetterQueueUrl: string | undefined;
    let sourceQueueUrl: string | undefined;

    try {
      const deadLetterQueue = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: deadLetterQueueName,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
        }),
      );
      deadLetterQueueUrl = deadLetterQueue.QueueUrl;
      if (!deadLetterQueueUrl) throw new Error('LocalStack did not return the DLQ URL');

      const attributes = await sqsClient.send(
        new GetQueueAttributesCommand({ QueueUrl: deadLetterQueueUrl, AttributeNames: ['QueueArn'] }),
      );
      const deadLetterArn = attributes.Attributes?.QueueArn;
      if (!deadLetterArn) throw new Error('LocalStack did not return the DLQ ARN');

      const sourceQueue = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: sourceQueueName,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
            VisibilityTimeout: '0',
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadLetterArn, maxReceiveCount: '2' }),
          },
        }),
      );
      sourceQueueUrl = sourceQueue.QueueUrl;
      if (!sourceQueueUrl) throw new Error('LocalStack did not return the source queue URL');
      process.env.AWS_SQS_QUEUE_URL = sourceQueueUrl;

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: sourceQueueUrl,
          MessageBody: '{malformed-json',
          MessageGroupId: 'malformed-group',
          MessageDeduplicationId: crypto.randomUUID(),
        }),
      );

      const consumer = new SqsWagerConsumerWorker(sqsClient, orm!.em.fork());
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const received = await sqsClient.send(
          new ReceiveMessageCommand({ QueueUrl: sourceQueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
        );
        const message = received.Messages?.[0];
        if (!message) break;
        await consumer.handleMessage(message);
        if (message.ReceiptHandle) {
          await sqsClient.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: sourceQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        }
      }

      const deadLetterMessages = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: deadLetterQueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
      );
      expect(deadLetterMessages.Messages).toHaveLength(1);
    } finally {
      if (previousQueueUrl === undefined) delete process.env.AWS_SQS_QUEUE_URL;
      else process.env.AWS_SQS_QUEUE_URL = previousQueueUrl;
      if (sourceQueueUrl) await sqsClient.send(new DeleteQueueCommand({ QueueUrl: sourceQueueUrl }));
      if (deadLetterQueueUrl) await sqsClient.send(new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }));
      sqsClient.destroy();
    }
  });

  it('should report a ledger mismatch without modifying the stored wallet balance', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const reconcileWallet = new ReconcileWalletUseCase(new PostgresUnitOfWork(orm!.em.fork()));

    const consistentResult = await reconcileWallet.execute(wallet.id);
    expect(consistentResult).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });

    await orm!.em.getConnection().execute(
      `UPDATE "${schemaName}".wallets SET balance = '95.00' WHERE id = ?`,
      [wallet.id],
    );
    const mismatchResult = await reconcileWallet.execute(wallet.id);

    expect(mismatchResult.storedBalance.amount).toBe('95.00');
    expect(mismatchResult.calculatedBalance.amount).toBe('100.00');
    expect(mismatchResult.difference.amount).toBe('-5.00');
    expect(mismatchResult.consistent).toBe(false);
    expect(mismatchResult.checkedEntries).toBe(1);

    const storedWallet = await new PostgresWalletRepository(orm!.em.fork()).findById(wallet.id);
    expect(storedWallet?.balance.toString()).toBe('95.00');
  });

  it('should query wallets, transactions, and ledger pages with a stable cursor', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await new CreateWalletUseCase(new PostgresUnitOfWork(orm!.em.fork())).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = crypto.randomUUID();
    const transaction = await createUseCase().execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'query-test-hash',
      walletId: wallet.id,
      playerId,
      roundId: 'round-query',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });
    const walletQueries = new GetWalletQueriesUseCase(new PostgresUnitOfWork(orm!.em.fork()));
    const transactionQueries = new GetWagerTransactionUseCase(new PostgresUnitOfWork(orm!.em.fork()));

    expect(await walletQueries.getWallet(wallet.id)).toEqual({
      id: wallet.id,
      playerId,
      balance: { amount: '90.00', currency: 'BRL' },
      version: 2,
    });
    expect((await transactionQueries.byId(transaction.transactionId)).transactionId).toBe(
      transaction.transactionId,
    );
    expect(
      (await transactionQueries.byExternalId('provider-a', externalTransactionId)).transactionId,
    ).toBe(transaction.transactionId);

    const firstPage = await walletQueries.getLedger(wallet.id, '1');
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await walletQueries.getLedger(wallet.id, '1', firstPage.nextCursor ?? undefined);
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(firstPage.entries[0]?.id).not.toBe(secondPage.entries[0]?.id);
  });

  it('should report readiness only when PostgreSQL and SQS are reachable', async () => {
    const sqsClient = createSqsClient();
    try {
      const healthController = new HealthController(orm!.em.fork(), sqsClient);
      expect(healthController.live()).toEqual({ status: 'ok' });
      expect(await healthController.ready()).toEqual({
        status: 'ok',
        checks: { postgres: 'ok', sqs: 'ok' },
      });
    } finally {
      sqsClient.destroy();
    }
  });
});
