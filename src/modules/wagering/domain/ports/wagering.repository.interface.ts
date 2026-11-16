import { Wallet } from '../entities/wallet.entity';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../entities/wallet-ledger-entry.entity';
import { IntegrationEvent } from '../events/integration-event';

export interface IWalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByIdWithLock(id: string): Promise<Wallet | null>; // Pessimistic Lock (FOR UPDATE)
  save(wallet: Wallet): Promise<void>;
}

export interface IWagerTransactionRepository {
  lockIdempotencyKey(key: string): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  hasSuccessfulReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    excludingTransactionId: string,
  ): Promise<boolean>;
  findPendingReferencesDue(at: Date, limit: number, maxAttempts: number): Promise<WagerTransaction[]>;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface IWalletLedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
  findPage(walletId: string, cursor: WalletLedgerCursor | undefined, limit: number): Promise<WalletLedgerPageEntry[]>;
  reconcile(walletId: string): Promise<WalletLedgerReconciliationSnapshot | null>;
}

export interface WalletLedgerCursor {
  createdAt: string;
  id: string;
}

export interface WalletLedgerPageEntry {
  entry: WalletLedgerEntry;
  cursor: WalletLedgerCursor;
}

export interface WalletLedgerReconciliationSnapshot {
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  checkedEntries: number;
}

export interface IOutboxRepository {
  enqueue(event: IntegrationEvent<object>): Promise<void>;
}

export interface IUnitOfWork {
  transactional<T>(work: (repositories: WageringRepositories) => Promise<T>): Promise<T>;
}

export interface WageringRepositories {
  wallets: IWalletRepository;
  wagers: IWagerTransactionRepository;
  ledger: IWalletLedgerRepository;
  outbox: IOutboxRepository;
}
