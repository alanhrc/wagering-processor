import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsEventPublisher } from '../messaging/sqs-event.publisher';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer: Timer | null = null;
  private isShuttingDown = false;
  private isProcessing = false;

  constructor(
    private readonly em: EntityManager,
    private readonly publisher: SqsEventPublisher,
  ) {}

  onModuleInit() {
    this.logger.log('Starting OutboxPublisherWorker...');
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
  }

  async onModuleDestroy() {
    this.logger.log('Stopping OutboxPublisherWorker (Graceful Shutdown)...');
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Aguarda o lote em andamento terminar antes de encerrar o processo
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.logger.log('OutboxPublisherWorker stopped cleanly.');
  }

  private async tick(): Promise<void> {
    if (this.isShuttingDown || this.isProcessing) return;
    this.isProcessing = true;

    try {
      await this.processBatch(20);
    } catch (error) {
      this.logger.error('Unexpected error in OutboxPublisherWorker', error);
    } finally {
      this.isProcessing = false;
    }
  }

  async processBatch(batchSize: number): Promise<number> {
    const fork = this.em.fork();

    return await fork.transactional(async (txEm) => {
      // FOR UPDATE SKIP LOCKED: permite múltiplas instâncias publicando sem colidir nas mesmas linhas
      const rows = await txEm.execute<
        Array<{
          id: string;
          aggregate_id: string;
          event_type: string;
          payload: any;
          occurred_at: Date;
          attempts: number;
        }>
      >(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts
         FROM outbox_messages
         WHERE published_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY occurred_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );

      for (const row of rows) {
        try {
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          await this.publisher.publish(payload);

          await txEm.execute(
            `UPDATE outbox_messages
             SET published_at = NOW(), attempts = attempts + 1
             WHERE id = ?`,
            [row.id],
          );
        } catch (err: any) {
          const nextAttempts = row.attempts + 1;
          const backoffSeconds = Math.min(Math.pow(2, nextAttempts) * 2, 300);

          await txEm.execute(
            `UPDATE outbox_messages
             SET attempts = ?, next_attempt_at = NOW() + MAKE_INTERVAL(secs => ?)
             WHERE id = ?`,
            [nextAttempts, backoffSeconds, row.id],
          );
          this.logger.warn(`Failed to publish outbox message ${row.id}, scheduled retry in ${backoffSeconds}s`);
        }
      }

      return rows.length;
    });
  }
}
