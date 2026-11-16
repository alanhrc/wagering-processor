import { createHash } from 'crypto';
import { Money } from '../../../../shared/domain/value-objects/money';
import { Wallet } from '../../domain/entities/wallet.entity';
import { WagerTransaction, WagerTransactionKind } from '../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/entities/wallet-ledger-entry.entity';
import { IUnitOfWork } from '../../domain/ports/wagering.repository.interface';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export class CreateWalletUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: command.playerId,
      initialBalance,
    });

    return this.uow.transactional(async ({ wallets, wagers, ledger, outbox }) => {
      await wallets.save(wallet);

      if (initialBalance.isPositive()) {
        const openingTransaction = WagerTransaction.create({
          id: crypto.randomUUID(),
          providerId: 'internal',
          externalTransactionId: `wallet-opening:${wallet.id}`,
          idempotencyKey: `wallet-opening:${wallet.id}`,
          payloadHash: createHash('sha256').update(`${wallet.id}:${initialBalance.toString()}`).digest('hex'),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'wallet-opening',
          gameId: 'internal',
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
        });
        openingTransaction.markProcessed();
        openingTransaction.recordResultBalance(initialBalance);

        await wagers.save(openingTransaction);
        const entry = WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId: openingTransaction.id,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
        });
        await ledger.save(entry);
        const context = {
          correlationId: openingTransaction.id,
          causationId: openingTransaction.externalTransactionId,
        };
        await outbox.enqueue(
          WagerTransactionProcessed.from(openingTransaction, wallet.balance.toJSON(), context),
        );
        await outbox.enqueue(WalletBalanceChanged.from(wallet, entry, context));
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
