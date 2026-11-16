import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';

import { WageringController } from './presentation/http/wagering.controller';
import { WalletController } from './presentation/http/wallet.controller';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { PostgresUnitOfWork } from './infrastructure/persistence/repositories/postgres-uow';
import { createSqsClient } from './infrastructure/messaging/sqs.client';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event.publisher';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { SqsWagerConsumerWorker } from './infrastructure/workers/sqs-wager-consumer.worker';

@Module({
  controllers: [WageringController, WalletController],
  providers: [
    {
      provide: SQSClient,
      useFactory: () => createSqsClient(),
    },
    SqsEventPublisher,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    SqsWagerConsumerWorker,
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => {
        return new ProcessWagerTransactionUseCase(new PostgresUnitOfWork(em));
      },
    },
    {
      provide: CreateWalletUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new CreateWalletUseCase(new PostgresUnitOfWork(em)),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new ReconcileWalletUseCase(new PostgresUnitOfWork(em)),
    },
  ],
})
export class WageringModule {}
