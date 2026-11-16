import { Wallet } from '../../domain/entities/wallet.entity';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import { IUnitOfWork, WalletLedgerCursor } from '../../domain/ports/wagering.repository.interface';
import { WalletNotFoundError } from './reconcile-wallet.use-case';

const defaultPageSize = 50;
const maximumPageSize = 100;

export class InvalidLedgerQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerQueryError';
  }
}

export interface WalletLedgerPage {
  walletId: string;
  entries: Array<{
    id: string;
    transactionId: string;
    direction: string;
    money: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    createdAt: Date;
  }>;
  nextCursor: string | null;
}

export class GetWalletQueriesUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  async getWallet(walletId: string) {
    return this.uow.transactional(async ({ wallets }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return this.serializeWallet(wallet);
    });
  }

  async getLedger(walletId: string, limitInput?: string, cursorInput?: string): Promise<WalletLedgerPage> {
    const limit = this.parseLimit(limitInput);
    const cursor = cursorInput ? this.decodeCursor(cursorInput) : undefined;

    return this.uow.transactional(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const rows = await ledger.findPage(walletId, cursor, limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = pageRows.at(-1);

      return {
        walletId,
        entries: pageRows.map(({ entry }) => this.serializeLedgerEntry(entry)),
        nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow.cursor) : null,
      };
    });
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) return defaultPageSize;
    if (!/^\d+$/.test(value)) throw new InvalidLedgerQueryError('limit must be an integer');
    const limit = Number(value);
    if (limit < 1 || limit > maximumPageSize) {
      throw new InvalidLedgerQueryError(`limit must be between 1 and ${maximumPageSize}`);
    }
    return limit;
  }

  private decodeCursor(value: string): WalletLedgerCursor {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error();
      }
      const cursor = parsed as Record<string, unknown>;
      if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string' || !cursor.id) {
        throw new Error();
      }
      const createdAt = new Date(cursor.createdAt);
      if (Number.isNaN(createdAt.getTime())) throw new Error();
      return { createdAt: cursor.createdAt, id: cursor.id };
    } catch {
      throw new InvalidLedgerQueryError('cursor is invalid');
    }
  }

  private encodeCursor(cursor: { createdAt: string; id: string }): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private serializeWallet(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private serializeLedgerEntry(entry: WalletLedgerEntry) {
    return {
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      createdAt: entry.createdAt,
    };
  }
}
