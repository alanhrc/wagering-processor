import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { IntegrationEventEnvelope } from '../../domain/events/integration-event';
import { SqsEventPublisher } from '../messaging/sqs-event.publisher';

function parseEventEnvelope(payload: unknown): IntegrationEventEnvelope<Record<string, unknown>> {
  const value: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Outbox payload must be an event envelope object');
  }

  const envelope = value as Record<string, unknown>;
  const requiredStringFields = ['eventId', 'eventType', 'aggregateId', 'correlationId', 'occurredAt'];
  if (
    requiredStringFields.some((field) => typeof envelope[field] !== 'string') ||
    typeof envelope.version !== 'number' ||
    envelope.data === null ||
    typeof envelope.data !== 'object' ||
    Array.isArray(envelope.data) ||
    (envelope.causationId !== undefined && typeof envelope.causationId !== 'string')
  ) {
    throw new Error('Outbox payload has an invalid event envelope');
  }

  return envelope as unknown as IntegrationEventEnvelope<Record<string, unknown>>;
}

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
    const lockToken = randomUUID();
    const rows = await fork.transactional(async (txEm) => {
      return txEm.execute<
        Array<{
          id: string;
          payload: unknown;
          attempts: number;
        }>
      >(
        `WITH candidates AS (
           SELECT id
           FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
             AND (locked_until IS NULL OR locked_until <= NOW())
           ORDER BY occurred_at ASC
           LIMIT ?
           FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_messages AS outbox
         SET lock_token = ?, locked_until = NOW() + INTERVAL '60 seconds'
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.id, outbox.payload, outbox.attempts`,
        [batchSize, lockToken],
      );
    });

    for (const row of rows) {
      try {
        const payload = parseEventEnvelope(row.payload);
        await this.publisher.publish(payload);
        await fork.getConnection().execute(
          `UPDATE outbox_messages
           SET published_at = NOW(), attempts = attempts + 1, next_attempt_at = NULL,
               lock_token = NULL, locked_until = NULL
           WHERE id = ? AND lock_token = ?`,
          [row.id, lockToken],
          'run',
        );
      } catch (error: unknown) {
        const nextAttempts = row.attempts + 1;
        const backoffSeconds = Math.min(2 ** nextAttempts * 2, 300);

        await fork.getConnection().execute(
          `UPDATE outbox_messages
           SET attempts = ?, next_attempt_at = NOW() + MAKE_INTERVAL(secs => ?),
               lock_token = NULL, locked_until = NULL
           WHERE id = ? AND lock_token = ?`,
          [nextAttempts, backoffSeconds, row.id, lockToken],
          'run',
        );
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to publish outbox message ${row.id}, scheduled retry in ${backoffSeconds}s: ${errorMessage}`,
        );
      }
    }

    return rows.length;
  }
}
