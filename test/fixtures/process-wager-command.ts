import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/entities/wager-transaction.entity';
import { WalletLedgerEntryOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wallet-ledger.orm-entity';
import { WalletOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wallet.orm-entity';
import { WagerTransactionOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wager-transaction.orm-entity';
import { PostgresUnitOfWork } from '../../src/modules/wagering/infrastructure/persistence/repositories/postgres-uow';

const [schema, walletId, playerId, externalTransactionId] = process.argv.slice(2);
if (!schema || !walletId || !playerId || !externalTransactionId) {
  throw new Error('Expected schema, wallet ID, player ID, and external transaction ID');
}

const orm = await MikroORM.init({
  ...config,
  entities: [WalletOrmEntity, WagerTransactionOrmEntity, WalletLedgerEntryOrmEntity],
  entitiesTs: [],
  metadataProvider: ReflectMetadataProvider,
  dbName: process.env.DB_POSTGRES_NAME || 'wagering_db',
  host: 'localhost',
  port: Number(process.env.DB_POSTGRES_PORT) || 5436,
  schema,
});

try {
  const result = await new ProcessWagerTransactionUseCase(
    new PostgresUnitOfWork(orm.em.fork()),
  ).execute({
    providerId: 'provider-process-test',
    externalTransactionId,
    idempotencyKey: `provider-process-test:${externalTransactionId}`,
    payloadHash: externalTransactionId,
    walletId,
    playerId,
    roundId: 'round-three-processes',
    gameId: 'slot-hot',
    kind: WagerTransactionKind.Bet,
    money: { amount: '60.00', currency: 'BRL' },
  });
  process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
} finally {
  await orm.close(true);
}
