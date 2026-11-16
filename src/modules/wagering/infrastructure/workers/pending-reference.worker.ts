import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  maximumReferenceAttempts,
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { PostgresWagerTransactionRepository } from '../persistence/repositories/postgres-wager-transaction.repository';
import { WageringMetrics } from '../../../../shared/infrastructure/observability/wagering-metrics';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: Timer | null = null;
  private isShuttingDown = false;
  private isProcessing = false;

  constructor(
    private readonly em: EntityManager,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly metrics: WageringMetrics = new WageringMetrics(),
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1_000);
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async tick(): Promise<void> {
    if (this.isShuttingDown || this.isProcessing) return;
    this.isProcessing = true;

    try {
      const em = this.em.fork();
      const repository = new PostgresWagerTransactionRepository(em);
      const transactions = await repository.findPendingReferencesDue(new Date(), 20, maximumReferenceAttempts);

      for (const transaction of transactions) {
        if (this.isShuttingDown) break;
        const startedAt = performance.now();
        try {
          this.metrics.recordRetry('pending_reference');
          const result = await this.processWagerTransaction.execute({
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            payloadHash: transaction.payloadHash,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            money: transaction.money.toJSON(),
            referenceExternalTransactionId: transaction.referenceExternalTransactionId,
          });
          this.metrics.recordTransaction(result.status);
        } catch (error: unknown) {
          this.metrics.recordDatabaseError(error);
          this.logger.error('pending_reference_retry_failed', {
            event: 'pending_reference_retry_failed',
            correlationId: transaction.idempotencyKey,
            transactionId: transaction.id,
            walletId: transaction.walletId,
            providerId: transaction.providerId,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          });
        } finally {
          this.metrics.recordProcessingDuration(performance.now() - startedAt);
        }
      }
    } catch (error: unknown) {
      this.metrics.recordDatabaseError(error);
      this.logger.error('pending_reference_poll_failed', {
        event: 'pending_reference_poll_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.isProcessing = false;
    }
  }
}
