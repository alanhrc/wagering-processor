import { EntityManager } from '@mikro-orm/core';
import { IOutboxRepository } from '../../../domain/ports/wagering.repository.interface';
import { IntegrationEvent } from '../../../domain/events/integration-event';

export class PostgresOutboxRepository implements IOutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(event: IntegrationEvent<object>): Promise<void> {
    const envelope = event.toJSON();
    const schema = this.em.config.getSchema();
    const quotedSchema = schema?.replaceAll('"', '""');
    const tableName = quotedSchema ? `"${quotedSchema}".outbox_messages` : 'outbox_messages';

    await this.em.getConnection().execute(
      `INSERT INTO ${tableName} (id, aggregate_id, event_type, payload, occurred_at)
       VALUES (?, ?, ?, ?::jsonb, ?)`,
      [
        envelope.eventId,
        envelope.aggregateId,
        envelope.eventType,
        JSON.stringify(envelope),
        envelope.occurredAt,
      ],
      'run',
      this.em.getTransactionContext(),
    );
  }
}
