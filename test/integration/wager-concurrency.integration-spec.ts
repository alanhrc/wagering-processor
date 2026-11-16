import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';

import { PostgresWalletRepository } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-wallet.repository';

import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { Wallet } from '../../src/modules/wagering/domain/entities/wallet.entity';
import { Money } from '../../src/shared/domain/value-objects/money';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/entities/wager-transaction.entity';
import { IUnitOfWork } from '../../src/modules/wagering/domain/ports/wagering.repository.interface';
import { WalletLedgerEntryOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wallet-ledger.orm-entity';
import { PostgresWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-wager-transaction.repository';
import { PostgresWalletLedgerRepository } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-ledger.repository';

describe('Wagering Concurrency & Integration Tests', () => {
  let orm: MikroORM | undefined;
  const dbName = process.env.DB_POSTGRES_NAME || 'wagering_db';
  const dbPort = parseInt(process.env.DB_POSTGRES_PORT || '5436');
  const keepTestSchema = process.env.KEEP_TEST_SCHEMA === 'true';
  const schemaName = keepTestSchema
    ? 'wagering_integration_audit'
    : `wagering_integration_${crypto.randomUUID().replaceAll('-', '')}`;

  beforeEach(async () => {
    if (!orm) {
      orm = await MikroORM.init({
        ...config,
        dbName: dbName,
        host: 'localhost',
        port: dbPort,
        schema: schemaName,
        migrations: { ...config.migrations, snapshot: false },
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
    const walletRepo = new PostgresWalletRepository(em);
    const wagerRepo = new PostgresWagerTransactionRepository(em);
    const ledgerRepo = new PostgresWalletLedgerRepository(em);

    // Usa o próprio `em` já isolado para garantir que o lock FOR UPDATE ocorra na mesma conexão
    const uow: IUnitOfWork = {
      transactional: async <T>(work: () => Promise<T>): Promise<T> => {
        await em.begin();
        try {
          const result = await work();
          await em.commit();
          return result;
        } catch (error) {
          await em.rollback();
          throw error;
        }
      },
    };

    return new ProcessWagerTransactionUseCase(walletRepo, wagerRepo, ledgerRepo, uow);
  };

  it('should process concurrent bets correctly: only one succeeds and leaves balance at 20.00 BRL', async () => {
    const setupEm = orm!.em.fork();
    const setupWalletRepo = new PostgresWalletRepository(setupEm);

    // 1. Criar carteira com 100.00 BRL
    const runId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const walletId = crypto.randomUUID();
    const initialWallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await setupWalletRepo.save(initialWallet);

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
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId })).toBe(1);
  });
});
