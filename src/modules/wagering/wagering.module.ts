import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';

import { WageringController } from './presentation/http/wagering.controller';
import { WalletController } from './presentation/http/wallet.controller';
import { ProviderWageringController } from './presentation/http/provider-wagering.controller';
import { HealthController } from './presentation/http/health.controller';
import { MetricsController } from './presentation/http/metrics.controller';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { GetWalletQueriesUseCase } from './application/use-cases/get-wallet-queries.use-case';
import { GetWagerTransactionUseCase } from './application/use-cases/get-wager-transaction.use-case';
import { PostgresUnitOfWork } from './infrastructure/persistence/repositories/postgres-uow';
import { createSqsClient } from './infrastructure/messaging/sqs.client';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event.publisher';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { SqsWagerConsumerWorker } from './infrastructure/workers/sqs-wager-consumer.worker';
import { WageringMetrics } from '../../shared/infrastructure/observability/wagering-metrics';
import { ProviderIdentityGuard } from '../../shared/infrastructure/auth/provider-identity.guard';

@Module({
  controllers: [WageringController, WalletController, ProviderWageringController, HealthController, MetricsController],
  providers: [
    WageringMetrics,
    ProviderIdentityGuard,
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
    {
      provide: GetWalletQueriesUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new GetWalletQueriesUseCase(new PostgresUnitOfWork(em)),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new GetWagerTransactionUseCase(new PostgresUnitOfWork(em)),
    },
  ],
})
export class WageringModule {}
