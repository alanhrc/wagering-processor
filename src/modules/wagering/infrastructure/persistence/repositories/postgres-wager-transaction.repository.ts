import { EntityManager } from '@mikro-orm/core';
import { IWagerTransactionRepository } from '../../../domain/ports/wagering.repository.interface';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/entities/wager-transaction.entity';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { Money } from '../../../../../shared/domain/value-objects/money';

export class PostgresWagerTransactionRepository implements IWagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const ormEntity = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey: key });
    if (!ormEntity) return null;

    return this.toDomain(ormEntity);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const ormEntity = await this.em.findOne(WagerTransactionOrmEntity, { providerId, externalTransactionId });
    if (!ormEntity) return null;

    return this.toDomain(ormEntity);
  }

  async hasSuccessfulReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    excludingTransactionId: string,
  ): Promise<boolean> {
    const count = await this.em.count(WagerTransactionOrmEntity, {
      providerId,
      referenceExternalTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
      id: { $ne: excludingTransactionId },
    });

    return count > 0;
  }

  async findPendingReferencesDue(at: Date, limit: number, maxAttempts: number): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionOrmEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        attempts: { $lt: maxAttempts },
        nextAttemptAt: { $lte: at },
      },
      { orderBy: { createdAt: 'ASC' }, limit },
    );

    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(ormEntity: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: ormEntity.id,
      providerId: ormEntity.providerId,
      externalTransactionId: ormEntity.externalTransactionId,
      idempotencyKey: ormEntity.idempotencyKey,
      payloadHash: ormEntity.payloadHash,
      walletId: ormEntity.walletId,
      playerId: ormEntity.playerId,
      roundId: ormEntity.roundId,
      gameId: ormEntity.gameId,
      kind: ormEntity.kind as any,
      money: Money.from({ amount: ormEntity.amount, currency: ormEntity.currency }),
      referenceExternalTransactionId: ormEntity.referenceExternalTransactionId,
      createdAt: ormEntity.createdAt,
      status: ormEntity.status as any,
      referenceTransactionId: ormEntity.referenceTransactionId,
      failureCode: ormEntity.failureCode as any,
      processedAt: ormEntity.processedAt,
      attempts: ormEntity.attempts,
      nextAttemptAt: ormEntity.nextAttemptAt,
    });
  }

  async save(transaction: WagerTransaction): Promise<void> {
    let ormEntity = await this.em.findOne(WagerTransactionOrmEntity, { id: transaction.id });

    if (!ormEntity) {
      ormEntity = this.em.create(WagerTransactionOrmEntity, {
        id: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        payloadHash: transaction.payloadHash,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        amount: transaction.money.toString(),
        currency: transaction.money.currency,
        status: transaction.status,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        referenceTransactionId: transaction.referenceTransactionId,
        failureCode: transaction.failureCode,
        createdAt: transaction.createdAt,
        processedAt: transaction.processedAt,
        attempts: transaction.attempts,
        nextAttemptAt: transaction.nextAttemptAt,
      });
      this.em.persist(ormEntity);
    } else {
      ormEntity.status = transaction.status;
      ormEntity.referenceTransactionId = transaction.referenceTransactionId;
      ormEntity.failureCode = transaction.failureCode;
      ormEntity.processedAt = transaction.processedAt;
      ormEntity.attempts = transaction.attempts;
      ormEntity.nextAttemptAt = transaction.nextAttemptAt;
    }

    await this.em.flush();
  }
}
