import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN lock_token UUID NULL;`);
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN locked_until TIMESTAMP WITH TIME ZONE NULL;`);
    this.addSql(
      `CREATE INDEX idx_outbox_messages_pending_occurred_at
       ON outbox_messages (occurred_at)
       WHERE published_at IS NULL;`,
    );
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_outbox_messages_pending_occurred_at;`);
    this.addSql(`ALTER TABLE outbox_messages DROP COLUMN IF EXISTS locked_until;`);
    this.addSql(`ALTER TABLE outbox_messages DROP COLUMN IF EXISTS lock_token;`);
  }
}
