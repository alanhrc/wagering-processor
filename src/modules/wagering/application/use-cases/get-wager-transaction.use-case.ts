import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { IUnitOfWork } from '../../domain/ports/wagering.repository.interface';

export class WagerTransactionNotFoundError extends Error {
  constructor() {
    super('Wager transaction not found');
    this.name = 'WagerTransactionNotFoundError';
  }
}

export class GetWagerTransactionUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  async byId(transactionId: string) {
    return this.uow.transactional(async ({ wagers }) => {
      const transaction = await wagers.findById(transactionId);
      if (!transaction) throw new WagerTransactionNotFoundError();
      return this.serialize(transaction);
    });
  }

  async byExternalId(providerId: string, externalTransactionId: string) {
    return this.uow.transactional(async ({ wagers }) => {
      const transaction = await wagers.findByExternalId(providerId, externalTransactionId);
      if (!transaction) throw new WagerTransactionNotFoundError();
      return this.serialize(transaction);
    });
  }

  private serialize(transaction: WagerTransaction) {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
      resultBalance: transaction.resultBalance?.toJSON(),
    };
  }
}
