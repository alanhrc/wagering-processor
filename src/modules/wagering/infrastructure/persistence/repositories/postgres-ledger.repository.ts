import { EntityManager } from '@mikro-orm/core';
import {
  IWalletLedgerRepository,
  WalletLedgerCursor,
  WalletLedgerPageEntry,
  WalletLedgerReconciliationSnapshot,
} from '../../../domain/ports/wagering.repository.interface';
import { LedgerDirection, WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger.orm-entity';
import { qualifiedTableName } from '../qualified-table-name';
import { Money } from '../../../../../shared/domain/value-objects/money';

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

  async findPage(
    walletId: string,
    cursor: WalletLedgerCursor | undefined,
    limit: number,
  ): Promise<WalletLedgerPageEntry[]> {
    const ledgerTable = qualifiedTableName(this.em, 'wallet_ledger_entries');
    const cursorClause = cursor ? 'AND (created_at, id) < (?::timestamptz, ?)' : '';
    const parameters = cursor
      ? [walletId, cursor.createdAt, cursor.id, limit]
      : [walletId, limit];
    const rows = await this.em.getConnection().execute<
      Array<{
        id: string;
        wallet_id: string;
        transaction_id: string;
        direction: string;
        amount: string;
        currency: string;
        balance_before: string;
        balance_after: string;
        created_at: Date;
        cursor_created_at: string;
      }>
    >(
      `SELECT id, wallet_id, transaction_id, direction, amount::text, currency,
              balance_before::text, balance_after::text, created_at,
              created_at::text AS cursor_created_at
       FROM ${ledgerTable}
       WHERE wallet_id = ? ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      parameters,
      'all',
    );

    return rows.map((row: {
      id: string;
      wallet_id: string;
      transaction_id: string;
      direction: string;
      amount: string;
      currency: string;
      balance_before: string;
      balance_after: string;
      created_at: Date;
      cursor_created_at: string;
    }) => ({
      entry: WalletLedgerEntry.rehydrate({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction as LedgerDirection,
        money: Money.from({ amount: row.amount, currency: row.currency }),
        balanceBefore: Money.from({ amount: row.balance_before, currency: row.currency }),
        balanceAfter: Money.from({ amount: row.balance_after, currency: row.currency }),
        createdAt: row.created_at,
      }),
      cursor: { createdAt: row.cursor_created_at, id: row.id },
    }));
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
