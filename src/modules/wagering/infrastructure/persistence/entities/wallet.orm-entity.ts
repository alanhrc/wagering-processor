import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
export class WalletOrmEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'string' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'numeric', precision: 15, scale: 2 })
  balance!: string;

  @Property({ type: 'int', default: 1 })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'datetime', default: 'NOW()' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', type: 'datetime', default: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
