import { Wallet } from '../entities/wallet.entity';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../entities/wallet-ledger-entry.entity';

export interface IWalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByIdWithLock(id: string): Promise<Wallet | null>; // Pessimistic Lock (FOR UPDATE)
  save(wallet: Wallet): Promise<void>;
}

export interface IWagerTransactionRepository {
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface IWalletLedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
}

export interface IUnitOfWork {
  transactional<T>(work: () => Promise<T>): Promise<T>;
}
