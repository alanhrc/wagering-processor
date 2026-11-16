import { EntityManager, LockMode } from '@mikro-orm/core';
import { WalletOrmEntity } from '../entities/wallet.orm-entity';
import { IWalletRepository } from '../../../domain/ports/wagering.repository.interface';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { Money } from '../../../../../shared/domain/value-objects/money';

export class PostgresWalletRepository implements IWalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const ormEntity = await this.em.findOne(WalletOrmEntity, { id });
    if (!ormEntity) return null;

    return Wallet.rehydrate({
      id: ormEntity.id,
      playerId: ormEntity.playerId,
      currency: ormEntity.currency,
      balance: Money.from({ amount: ormEntity.balance, currency: ormEntity.currency }),
      version: ormEntity.version,
      createdAt: ormEntity.createdAt,
      updatedAt: ormEntity.updatedAt,
    });
  }

  async findByIdWithLock(id: string): Promise<Wallet | null> {
    // LOCK PESSIMISTA: SELECT ... FOR UPDATE sob o capô do Postgres
    const ormEntity = await this.em.findOne(
      WalletOrmEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE }
    );
    if (!ormEntity) return null;

    return Wallet.rehydrate({
      id: ormEntity.id,
      playerId: ormEntity.playerId,
      currency: ormEntity.currency,
      balance: Money.from({ amount: ormEntity.balance, currency: ormEntity.currency }),
      version: ormEntity.version,
      createdAt: ormEntity.createdAt,
      updatedAt: ormEntity.updatedAt,
    });
  }

  async save(wallet: Wallet): Promise<void> {
    let ormEntity = await this.em.findOne(WalletOrmEntity, { id: wallet.id });

    if (!ormEntity) {
      ormEntity = this.em.create(WalletOrmEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toString(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
      this.em.persist(ormEntity);
    } else {
      ormEntity.balance = wallet.balance.toString();
      ormEntity.version = wallet.version;
      ormEntity.updatedAt = wallet.updatedAt;
    }

    await this.em.flush();
  }
}
