import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';

import { WageringController } from './presentation/http/wagering.controller';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { PostgresUnitOfWork } from './infrastructure/persistence/repositories/postgres-uow';
import { createSqsClient } from './infrastructure/messaging/sqs.client';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event.publisher';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { SqsWagerConsumerWorker } from './infrastructure/workers/sqs-wager-consumer.worker';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: SQSClient,
      useFactory: () => createSqsClient(),
    },
    SqsEventPublisher,
    OutboxPublisherWorker,
    SqsWagerConsumerWorker,
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => {
        return new ProcessWagerTransactionUseCase(new PostgresUnitOfWork(em));
      },
    },
  ],
})
export class WageringModule {}
