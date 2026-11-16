import { EntityManager } from '@mikro-orm/core';
import {
  IUnitOfWork,
  WageringRepositories,
} from '../../../domain/ports/wagering.repository.interface';
import { PostgresWalletRepository } from './postgres-wallet.repository';
import { PostgresWagerTransactionRepository } from './postgres-wager-transaction.repository';
import { PostgresWalletLedgerRepository } from './postgres-ledger.repository';
import { PostgresOutboxRepository } from './postgres-outbox.repository';

export class PostgresUnitOfWork implements IUnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly runInCurrentTransaction = false,
  ) {}

  static forCurrentTransaction(em: EntityManager): PostgresUnitOfWork {
    return new PostgresUnitOfWork(em, true);
  }

  async transactional<T>(work: (repositories: WageringRepositories) => Promise<T>): Promise<T> {
    if (this.runInCurrentTransaction) {
      return work(this.createRepositories(this.em));
    }

    const fork = this.em.fork();
    return fork.transactional(async (txEm) => {
      return work(this.createRepositories(txEm));
    });
  }

  private createRepositories(em: EntityManager): WageringRepositories {
    return {
      wallets: new PostgresWalletRepository(em),
      wagers: new PostgresWagerTransactionRepository(em),
      ledger: new PostgresWalletLedgerRepository(em),
      outbox: new PostgresOutboxRepository(em),
    };
  }
}
