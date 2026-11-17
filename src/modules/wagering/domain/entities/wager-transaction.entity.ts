import { Money } from '../../../../shared/domain/value-objects/money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  DuplicateTransaction = 'DUPLICATE_TRANSACTION',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InvalidStateTransition = 'INVALID_STATE_TRANSITION',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  InvalidAmount = 'INVALID_AMOUNT',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletOwnershipMismatch = 'WALLET_OWNERSHIP_MISMATCH',
}

export class InvalidWagerAmountError extends Error {
  constructor() {
    super('Wager transaction amount must be positive');
    this.name = 'InvalidWagerAmountError';
  }
}

export class MissingWagerReferenceError extends Error {
  constructor(kind: WagerTransactionKind) {
    super(`Transaction kind ${kind} requires a referenceExternalTransactionId`);
    this.name = 'MissingWagerReferenceError';
  }
}

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  attempts?: number;
  nextAttemptAt?: Date;
  resultBalance?: Money;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _attempts = 0,
    private _nextAttemptAt?: Date,
    private _resultBalance?: Money,
  ) {}

  static create(props: Omit<WagerTransactionProps, 'createdAt' | 'status'>): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerAmountError();
    }
    // Validação de regra: REFUND e ROLLBACK exigem referência externa
    if ((props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) && !props.referenceExternalTransactionId) {
      throw new MissingWagerReferenceError(props.kind);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      props.status,
      props.referenceTransactionId,
      props.failureCode,
      props.processedAt,
      props.attempts,
      props.nextAttemptAt,
      props.resultBalance,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get resultBalance(): Money | undefined { return this._resultBalance; }

  public recordResultBalance(balance: Money): void {
    if (balance.currency !== this.money.currency && this._status !== WagerTransactionStatus.Rejected) {
      throw new Error('Result balance currency must match transaction currency');
    }
    this._resultBalance = balance;
  }

  public markProcessed(referenceTransactionId?: string): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date();
    this._nextAttemptAt = undefined;
  }

  public markPendingReference(): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
  }

  public scheduleReferenceRetry(at: Date, delayMilliseconds: number): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = new Date(at.getTime() + delayMilliseconds);
  }

  public reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
    this._nextAttemptAt = undefined;
  }

  public fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  public isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  public affectsBalance(): boolean {
    // LOSS e REJECTED/FAILED não alteram o saldo da carteira
    if (this._status !== WagerTransactionStatus.Processed) return false;
    return this.kind !== WagerTransactionKind.Loss;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new Error(`Cannot transition transaction ${this.id} because it is already in a terminal state: ${this._status}`);
    }
  }
}
