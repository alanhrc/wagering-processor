import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  maximumReferenceAttempts,
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { PostgresWagerTransactionRepository } from '../persistence/repositories/postgres-wager-transaction.repository';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: Timer | null = null;
  private isShuttingDown = false;
  private isProcessing = false;

  constructor(
    private readonly em: EntityManager,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
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
        try {
          await this.processWagerTransaction.execute({
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
        } catch (error) {
          this.logger.error(`Failed to retry pending reference ${transaction.id}`, error);
        }
      }
    } catch (error) {
      this.logger.error('Error polling pending wager references', error);
    } finally {
      this.isProcessing = false;
    }
  }
}
