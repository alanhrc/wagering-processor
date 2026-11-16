import { EntityManager } from '@mikro-orm/core';
import { IWagerTransactionRepository } from '../../../domain/ports/wagering.repository.interface';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { Money } from '../../../../../shared/domain/value-objects/money';

export class PostgresWagerTransactionRepository implements IWagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const ormEntity = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey: key });
    if (!ormEntity) return null;

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
    });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const ormEntity = await this.em.findOne(WagerTransactionOrmEntity, { providerId, externalTransactionId });
    if (!ormEntity) return null;

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
      });
      this.em.persist(ormEntity);
    } else {
      ormEntity.status = transaction.status;
      ormEntity.referenceTransactionId = transaction.referenceTransactionId;
      ormEntity.failureCode = transaction.failureCode;
      ormEntity.processedAt = transaction.processedAt;
    }

    await this.em.flush();
  }
}
