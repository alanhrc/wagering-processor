import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';
import { WalletOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wallet.orm-entity.js';
import { WalletLedgerEntryOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wallet-ledger.orm-entity.js';
import { WagerTransactionOrmEntity } from '../../src/modules/wagering/infrastructure/persistence/entities/wager-transaction.orm-entity.js';
import { SqsWagerConsumerWorker } from '../../src/modules/wagering/infrastructure/workers/sqs-wager-consumer.worker.js';
import { createSqsClient } from '../../src/modules/wagering/infrastructure/messaging/sqs.client.js';

const [schema, queueUrl, mode] = process.argv.slice(2);
if (!schema || !queueUrl || !['crash', 'recover'].includes(mode ?? '')) throw new Error('Expected schema, queue URL and crash/recover mode');
const orm = await MikroORM.init({
  ...config,
  schema,
  host: 'localhost',
  entities: [WalletOrmEntity, WalletLedgerEntryOrmEntity, WagerTransactionOrmEntity],
  entitiesTs: [],
  metadataProvider: ReflectMetadataProvider,
});
const sqs = createSqsClient();
const intercepted = new Proxy(sqs, {
  get(target, property) {
    if (property === 'send') {
      return async (command: DeleteMessageCommand | ChangeMessageVisibilityCommand) => {
        if (command instanceof DeleteMessageCommand && mode === 'crash') {
          process.stdout.write('COMMITTED_BEFORE_ACK\n');
          await new Promise<void>(() => {});
        }
        return command instanceof DeleteMessageCommand ? sqs.send(command) : sqs.send(command);
      };
    }
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
try {
  const delivery = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 10, MaxNumberOfMessages: 1 }));
  const message = delivery.Messages?.[0];
  if (!message) throw new Error('No SQS delivery received by fixture worker');
  await new SqsWagerConsumerWorker(intercepted, orm.em.fork()).handleMessage(message);
  process.stdout.write('WORKER_COMPLETED\n');
} finally {
  sqs.destroy();
  await orm.close(true);
}
