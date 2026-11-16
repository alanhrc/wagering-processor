import { Migration } from '@mikro-orm/migrations';

export class Migration20261117000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN result_balance NUMERIC(15, 2) NULL;`);
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN IF EXISTS result_balance;`);
  }
}
