import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';

import { WageringController } from './presentation/http/wagering.controller';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { PostgresWalletRepository } from './infrastructure/persistence/repositories/postgres-wallet.repository';
import { PostgresWagerTransactionRepository } from './infrastructure/persistence/repositories/postgres-wager-transaction.repository';
import { PostgresWalletLedgerRepository } from './infrastructure/persistence/repositories/postgres-ledger.repository';
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
        // Para cada execução HTTP, criamos um fork isolado do EntityManager dentro do transactional
        const uow = {
          transactional: async <T>(work: () => Promise<T>): Promise<T> => {
            const fork = em.fork();
            return await fork.transactional(async () => work());
          },
        };

        return new ProcessWagerTransactionUseCase(
          new PostgresWalletRepository(em),
          new PostgresWagerTransactionRepository(em),
          new PostgresWalletLedgerRepository(em),
          uow,
        );
      },
    },
  ],
})
export class WageringModule {}
