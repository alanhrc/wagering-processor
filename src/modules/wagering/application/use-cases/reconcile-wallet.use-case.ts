import { Money } from '../../../../shared/domain/value-objects/money';
import { IUnitOfWork } from '../../domain/ports/wagering.repository.interface';

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet not found: ${walletId}`);
    this.name = 'WalletNotFoundError';
  }
}

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    return this.uow.transactional(async ({ ledger }) => {
      const snapshot = await ledger.reconcile(walletId);
      if (!snapshot) throw new WalletNotFoundError(walletId);

      const storedBalance = Money.from({ amount: snapshot.storedBalance, currency: snapshot.currency });
      const calculatedBalance = Money.from({ amount: snapshot.calculatedBalance, currency: snapshot.currency });

      return {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: storedBalance.subtract(calculatedBalance).toJSON(),
        consistent: storedBalance.equals(calculatedBalance),
        checkedEntries: snapshot.checkedEntries,
      };
    });
  }
}
