import { Money } from '../../../../shared/domain/value-objects/money';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InvalidInitialWalletBalanceError extends Error {
  constructor() {
    super('Initial wallet balance cannot be negative');
    this.name = 'InvalidInitialWalletBalanceError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Factory para abrir uma nova carteira.
   * Inicia na versão 1.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new Error('Wallet ID and Player ID are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidInitialWalletBalanceError();
    }

    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1, // Versão inicial
      now,
      now,
    );
  }

  /**
   * Reidratação a partir da persistência (Banco de Dados).
   * Não revalida regras de negócio de transição, apenas reconstrói o estado salvo.
   */
  static rehydrate(props: WalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.currency,
      props.balance,
      props.version,
      props.createdAt,
      props.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Debita um valor da carteira (usado em BET).
   * Invariante: O saldo nunca pode ficar negativo.
   */
  public debit(amount: Money): void {
    this.assertSameCurrency(amount);

    if (amount.isZero() || amount.isNegative()) {
      throw new Error('Debit amount must be greater than zero');
    }

    // Se o saldo for menor que o valor a debitar, viola a invariante de saldo não-negativo
    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(
        `Insufficient funds in wallet ${this.id}. Current: ${this._balance.toString()}, Requested: ${amount.toString()}`
      );
    }

    this._balance = this._balance.subtract(amount);
    this._version += 1;
    this._updatedAt = new Date();
  }

  /**
   * Credita um valor na carteira (usado em WIN, REFUND, ROLLBACK, OPENING).
   */
  public credit(amount: Money): void {
    this.assertSameCurrency(amount);

    if (amount.isZero() || amount.isNegative()) {
      throw new Error('Credit amount must be greater than zero');
    }

    this._balance = this._balance.add(amount);
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new Error(
        `Currency mismatch in wallet ${this.id}: Wallet is ${this.currency}, operation is ${money.currency}`
      );
    }
  }
}

/**
 * Erro específico de domínio para saldo insuficiente.
 * Essencial para o controller mapear para o código HTTP correto (ex: 422 Unprocessable Entity).
 */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}
