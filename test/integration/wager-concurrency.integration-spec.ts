import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';

// Entidades ORM (passadas como classe no nativeDelete)
// Repositórios
import { PostgresWalletRepository } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-wallet.repository';

// Domínio e Caso de Uso
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
  let orm: MikroORM;

  beforeEach(async () => {
    if (!orm) {
      orm = await MikroORM.init({
        ...config,
        dbName: 'wagering_db',
        clientUrl: 'postgresql://postgres:postgres@localhost:5436/wagering_db',
      });
    }

    const em = orm.em.fork();
    await em.getConnection().execute('TRUNCATE TABLE wallet_ledger_entries, wager_transactions, wallets CASCADE');
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  // Helper para instanciar o Use Case com um EntityManager isolado por requisição
  const createUseCase = () => {
    const em = orm.em.fork();
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
    const setupEm = orm.em.fork();
    const setupWalletRepo = new PostgresWalletRepository(setupEm);

    // 1. Criar carteira com 100.00 BRL
    const walletId = 'wallet-test-concurrency';
    const initialWallet = Wallet.open({
      id: walletId,
      playerId: 'player-999',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await setupWalletRepo.save(initialWallet);

    // 2. Cada chamada simultânea simula uma requisição/instância diferente (com seu próprio EM)
    const useCase1 = createUseCase();
    const useCase2 = createUseCase();

    const promise1 = useCase1.execute({
      providerId: 'provider-a',
      externalTransactionId: 'tx-80-one',
      idempotencyKey: 'prov:tx-80-one',
      payloadHash: 'hash1',
      walletId,
      playerId: 'player-999',
      roundId: 'round-1',
      gameId: 'slot-hot',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    });

    const promise2 = useCase2.execute({
      providerId: 'provider-a',
      externalTransactionId: 'tx-80-two',
      idempotencyKey: 'prov:tx-80-two',
      payloadHash: 'hash2',
      walletId,
      playerId: 'player-999',
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
    const verifyEm = orm.em.fork();
    const verifyWalletRepo = new PostgresWalletRepository(verifyEm);
    const finalWallet = await verifyWalletRepo.findById(walletId);
    expect(finalWallet?.balance.toString()).toBe('20.00');
    expect(await verifyEm.count(WalletLedgerEntryOrmEntity, { walletId })).toBe(1);
  });
});
