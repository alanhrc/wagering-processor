import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'string' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'string' })
  externalTransactionId!: string;

  @Unique()
  @Property({ fieldName: 'idempotency_key', type: 'string' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'string' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'string' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'string' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'string' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'string' })
  gameId!: string;

  @Property({ type: 'string' })
  kind!: string;

  @Property({ type: 'numeric', precision: 15, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string' })
  status!: string;

  @Property({ fieldName: 'reference_external_transaction_id', type: 'string', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: 'reference_transaction_id', type: 'string', nullable: true })
  referenceTransactionId?: string;

  @Property({ fieldName: 'failure_code', type: 'string', nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'created_at', type: 'datetime', default: 'NOW()' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'processed_at', type: 'datetime', nullable: true })
  processedAt?: Date;

  @Property({ type: 'int', default: 0 })
  attempts = 0;

  @Property({ fieldName: 'next_attempt_at', type: 'datetime', nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: 'result_balance', type: 'numeric', precision: 15, scale: 2, nullable: true })
  resultBalance?: string | null;

  @Property({ fieldName: 'result_balance_currency', type: 'string', length: 3, nullable: true })
  resultBalanceCurrency?: string | null;
}
