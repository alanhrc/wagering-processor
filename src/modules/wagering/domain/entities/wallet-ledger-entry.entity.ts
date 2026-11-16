import { Money } from '../../../../shared/domain/value-objects/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new Error('Ledger entry requires ID, wallet ID, and transaction ID');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt || new Date(),
    );

    if (!entry.isBalanced()) {
      throw new Error(
        `Ledger arithmetic mismatch: Before (${props.balanceBefore.toString()}) ± Money (${props.money.toString()}) does not match After (${props.balanceAfter.toString()})`
      );
    }

    return entry;
  }

  static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt || new Date(),
    );
  }

  public isBalanced(): boolean {
    if (this.direction === LedgerDirection.Debit) {
      const expectedAfter = this.balanceBefore.subtract(this.money);
      return expectedAfter.equals(this.balanceAfter);
    } else {
      const expectedAfter = this.balanceBefore.add(this.money);
      return expectedAfter.equals(this.balanceAfter);
    }
  }
}
