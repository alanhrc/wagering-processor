import { EntityManager } from '@mikro-orm/core';
import { IWalletLedgerRepository } from '../../../domain/ports/wagering.repository.interface';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger.orm-entity';

export class PostgresWalletLedgerRepository implements IWalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    const ormEntity = this.em.create(WalletLedgerEntryOrmEntity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt,
    });

    this.em.persist(ormEntity);
    await this.em.flush();
  }
}
