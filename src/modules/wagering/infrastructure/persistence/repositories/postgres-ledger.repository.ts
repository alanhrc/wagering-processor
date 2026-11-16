import { EntityManager } from '@mikro-orm/core';
import {
  IWalletLedgerRepository,
  WalletLedgerReconciliationSnapshot,
} from '../../../domain/ports/wagering.repository.interface';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger.orm-entity';
import { qualifiedTableName } from '../qualified-table-name';

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

  async reconcile(walletId: string): Promise<WalletLedgerReconciliationSnapshot | null> {
    const walletsTable = qualifiedTableName(this.em, 'wallets');
    const ledgerTable = qualifiedTableName(this.em, 'wallet_ledger_entries');
    const rows = await this.em.getConnection().execute<
      Array<{
        currency: string;
        stored_balance: string;
        calculated_balance: string;
        checked_entries: string;
      }>
    >(
      `SELECT wallet.currency,
              wallet.balance::text AS stored_balance,
              COALESCE(SUM(CASE WHEN ledger.direction = 'CREDIT' THEN ledger.amount ELSE -ledger.amount END), 0)::text AS calculated_balance,
              COUNT(ledger.id)::text AS checked_entries
       FROM ${walletsTable} AS wallet
       LEFT JOIN ${ledgerTable} AS ledger ON ledger.wallet_id = wallet.id
       WHERE wallet.id = ?
       GROUP BY wallet.id, wallet.currency, wallet.balance`,
      [walletId],
      'all',
    );
    const row = rows[0];
    if (!row) return null;

    return {
      currency: row.currency,
      storedBalance: row.stored_balance,
      calculatedBalance: row.calculated_balance,
      checkedEntries: Number(row.checked_entries),
    };
  }
}
