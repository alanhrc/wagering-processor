import { Money } from '../../../../shared/domain/value-objects/money';
import { InsufficientFundsError } from '../../domain/entities/wallet.entity';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, FailureCode } from '../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/entities/wallet-ledger-entry.entity';
import { IUnitOfWork, WageringRepositories } from '../../domain/ports/wagering.repository.interface';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';
import { EventContext } from '../../domain/events/integration-event';

export const maximumReferenceAttempts = 10;
const maximumReferenceRetryDelayMilliseconds = 300_000;

export class InternalWagerTransactionError extends Error {
  constructor() {
    super('OPENING transactions can only be created when a wallet is opened');
    this.name = 'InternalWagerTransactionError';
  }
}

export class InvalidWagerTransactionKindError extends Error {
  constructor() {
    super('Unsupported wager transaction kind');
    this.name = 'InvalidWagerTransactionKindError';
  }
}

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super('Idempotency key conflict: same key with different payload');
    this.name = 'IdempotencyKeyConflictError';
  }
}

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
  correlationId?: string;
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
    if (!Object.values(WagerTransactionKind).includes(command.kind)) {
      throw new InvalidWagerTransactionKindError();
    }
    if (command.kind === WagerTransactionKind.Opening) {
      throw new InternalWagerTransactionError();
    }

    return this.uow.transactional(async (repositories) => {
      const { wallets, wagers, ledger, outbox } = repositories;
      const eventContext = this.eventContext(command);
      await wagers.lockIdempotencyKey(command.idempotencyKey);
      const existingTx = await wagers.findByIdempotencyKey(command.idempotencyKey);
      if (existingTx) {
        if (existingTx.payloadHash !== command.payloadHash) {
          throw new IdempotencyKeyConflictError();
        }
        if (existingTx.status !== WagerTransactionStatus.PendingReference) {
          const wallet = existingTx.resultBalance ? null : await wallets.findById(command.walletId);
          return this.result(
            existingTx,
            existingTx.resultBalance ?? wallet?.balance ?? Money.zero(money.currency),
            true,
          );
        }
        if (existingTx.nextAttemptAt && existingTx.nextAttemptAt > new Date()) {
          const wallet = existingTx.resultBalance ? null : await wallets.findById(command.walletId);
          return this.result(
            existingTx,
            existingTx.resultBalance ?? wallet?.balance ?? Money.zero(money.currency),
            true,
          );
        }
      }

      let transaction = existingTx ?? WagerTransaction.create({
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

      const wallet = await wallets.findByIdWithLock(command.walletId);
      if (!wallet) {
        throw new Error(`Wallet not found: ${command.walletId}`);
      }

      const currentTransaction = await wagers.findByIdempotencyKey(command.idempotencyKey);
      if (currentTransaction) {
        if (currentTransaction.payloadHash !== command.payloadHash) {
          throw new IdempotencyKeyConflictError();
        }
        transaction = currentTransaction;
        if (
          transaction.status !== WagerTransactionStatus.PendingReference ||
          (transaction.nextAttemptAt && transaction.nextAttemptAt > new Date())
        ) {
          return this.result(transaction, transaction.resultBalance ?? wallet.balance, true);
        }
      }

      if (wallet.playerId !== command.playerId) {
        transaction.reject(FailureCode.WalletOwnershipMismatch);
        return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
      }

      if (wallet.currency !== money.currency) {
        transaction.reject(FailureCode.CurrencyMismatch);
        return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
      }

      const requiresReference =
        command.kind === WagerTransactionKind.Refund || command.kind === WagerTransactionKind.Rollback;
      const resolvesOptionalWinReference =
        command.kind === WagerTransactionKind.Win && Boolean(command.referenceExternalTransactionId);
      let reference: WagerTransaction | null = null;

      if (requiresReference || resolvesOptionalWinReference) {
        reference = await wagers.findByExternalId(
          command.providerId,
          command.referenceExternalTransactionId!,
        );

        if (!reference) {
          return this.deferForReference(transaction, wallet.balance, repositories, eventContext, FailureCode.ReferenceNotFound);
        }

        if (reference.status !== WagerTransactionStatus.Processed) {
          if (reference.isTerminal()) {
            transaction.reject(FailureCode.ReferenceNotProcessed);
            return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
          }
          return this.deferForReference(transaction, wallet.balance, repositories, eventContext, FailureCode.ReferenceNotProcessed);
        }

        if (reference.money.currency !== money.currency) {
          transaction.reject(FailureCode.CurrencyMismatch);
          return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
        }

        if (
          reference.playerId !== command.playerId ||
          reference.walletId !== command.walletId ||
          reference.roundId !== command.roundId
        ) {
          transaction.reject(FailureCode.ReferenceMismatch);
          return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
        }

        const validReferenceKind =
          command.kind === WagerTransactionKind.Refund
            ? reference.kind === WagerTransactionKind.Bet
            : command.kind === WagerTransactionKind.Rollback
              ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind)
              : reference.kind === WagerTransactionKind.Bet;

        if (!validReferenceKind) {
          transaction.reject(FailureCode.InvalidReferenceKind);
          return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
        }

        if (requiresReference && !reference.money.equals(money)) {
          transaction.reject(FailureCode.ReferenceMismatch);
          return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
        }

        if (
          requiresReference &&
          await wagers.hasSuccessfulReversal(
            command.providerId,
            command.referenceExternalTransactionId!,
            transaction.id,
          )
        ) {
          transaction.reject(FailureCode.DuplicateTransaction);
          return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
        }
      }

      try {
        const balanceBefore = wallet.balance;
        let direction: LedgerDirection | undefined;

        if (command.kind === WagerTransactionKind.Bet) {
          wallet.debit(money);
          direction = LedgerDirection.Debit;
        } else if (command.kind === WagerTransactionKind.Win || command.kind === WagerTransactionKind.Refund) {
          wallet.credit(money);
          direction = LedgerDirection.Credit;
        } else if (command.kind === WagerTransactionKind.Rollback && reference) {
          if (reference.kind === WagerTransactionKind.Bet) {
            wallet.credit(money);
            direction = LedgerDirection.Credit;
          } else {
            wallet.debit(money);
            direction = LedgerDirection.Debit;
          }
        } else if (command.kind === WagerTransactionKind.Loss) {
          direction = undefined;
        }

        transaction.markProcessed(reference?.id);
        transaction.recordResultBalance(wallet.balance);
        await wagers.save(transaction);
        if (direction) {
          const ledgerEntry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction,
            money,
            balanceBefore,
            balanceAfter: wallet.balance,
          });
          await wallets.save(wallet);
          await ledger.save(ledgerEntry);
          await outbox.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, eventContext));
        }

        await outbox.enqueue(WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), eventContext));

        return this.result(transaction, wallet.balance, false);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          transaction.reject(
            command.kind === WagerTransactionKind.Rollback
              ? FailureCode.ReversalInsufficientFunds
              : FailureCode.InsufficientFunds,
          );
          return this.persistResult(transaction, wallet.balance, repositories, eventContext, false);
        }
        throw error;
      }
    });
  }

  private result(
    transaction: WagerTransaction,
    balance: Money,
    idempotentReplay: boolean,
  ): ProcessWagerResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: balance.toJSON(),
      idempotentReplay,
    };
  }

  private eventContext(command: ProcessWagerCommand): EventContext {
    return {
      correlationId: command.correlationId ?? command.idempotencyKey,
      causationId: command.externalTransactionId,
    };
  }

  private async persistResult(
    transaction: WagerTransaction,
    balance: Money,
    repositories: WageringRepositories,
    eventContext: EventContext,
    idempotentReplay: boolean,
  ): Promise<ProcessWagerResult> {
    transaction.recordResultBalance(balance);
    await repositories.wagers.save(transaction);
    if (transaction.status === WagerTransactionStatus.Rejected) {
      await repositories.outbox.enqueue(WagerTransactionRejected.from(transaction, eventContext));
    }
    return this.result(transaction, balance, idempotentReplay);
  }

  private async deferForReference(
    transaction: WagerTransaction,
    balance: Money,
    repositories: WageringRepositories,
    eventContext: EventContext,
    failureCode: FailureCode,
  ): Promise<ProcessWagerResult> {
    const wasAlreadyPendingReference = transaction.status === WagerTransactionStatus.PendingReference;
    if (transaction.attempts + 1 >= maximumReferenceAttempts) {
      transaction.reject(failureCode);
    } else {
      const retryNumber = transaction.attempts + 1;
      const retryDelay = Math.min(1_000 * 2 ** retryNumber, maximumReferenceRetryDelayMilliseconds);
      transaction.scheduleReferenceRetry(new Date(), retryDelay);
    }
    const result = await this.persistResult(transaction, balance, repositories, eventContext, false);
    if (
      !wasAlreadyPendingReference &&
      failureCode === FailureCode.ReferenceNotFound &&
      transaction.nextAttemptAt !== undefined
    ) {
      await repositories.outbox.enqueue(WagerTransactionPendingReference.from(transaction, eventContext));
    }
    return result;
  }
}
