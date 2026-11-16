import { Money } from '../../../../shared/domain/value-objects/money';
import { Wallet, InsufficientFundsError } from '../../domain/entities/wallet.entity';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, FailureCode } from '../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/entities/wallet-ledger-entry.entity';
import { IUnitOfWork } from '../../domain/ports/wagering.repository.interface';

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: IUnitOfWork,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const money = Money.from(command.money);

    return this.uow.transactional(async ({ wallets, wagers, ledger }) => {
      const existingTx = await wagers.findByIdempotencyKey(command.idempotencyKey);
      if (existingTx) {
        if (existingTx.payloadHash !== command.payloadHash) {
          throw new Error('Idempotency key conflict: same key with different payload');
        }
        const wallet = await wallets.findById(command.walletId);
        return {
          transactionId: existingTx.id,
          status: existingTx.status,
          balance: wallet ? wallet.balance.toJSON() : { amount: '0.00', currency: money.currency },
          idempotentReplay: true,
        };
      }

      // Criar transação em estado PENDING
      const transaction = WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: command.payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      });

      // Buscar wallet com lock pessimista (FOR UPDATE) para evitar concorrência/lost updates
      const wallet = await wallets.findByIdWithLock(command.walletId);
      if (!wallet) {
        transaction.reject(FailureCode.ReferenceNotFound);
        await wagers.save(transaction);
        throw new Error(`Wallet not found: ${command.walletId}`);
      }

      try {
        let ledgerEntry: WalletLedgerEntry | undefined;
        const balanceBefore = wallet.balance;

        if (command.kind === WagerTransactionKind.Bet) {
          wallet.debit(money);
          transaction.markProcessed();
          ledgerEntry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: LedgerDirection.Debit,
            money,
            balanceBefore,
            balanceAfter: wallet.balance,
          });
        } else if (command.kind === WagerTransactionKind.Win || command.kind === WagerTransactionKind.Refund) {
          wallet.credit(money);
          transaction.markProcessed();
          ledgerEntry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: LedgerDirection.Credit,
            money,
            balanceBefore,
            balanceAfter: wallet.balance,
          });
        } else if (command.kind === WagerTransactionKind.Loss) {
          // LOSS não altera saldo, mas registra a transação
          transaction.markProcessed();
        }

        // Persistir alterações de domínio na transação SQL
        await wallets.save(wallet);
        await wagers.save(transaction);
        if (ledgerEntry) {
          await ledger.save(ledgerEntry);
        }

        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };

      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          transaction.reject(FailureCode.InsufficientFunds);
          await wagers.save(transaction);

          return {
            transactionId: transaction.id,
            status: transaction.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }
        throw error;
      }
    });
  }
}
