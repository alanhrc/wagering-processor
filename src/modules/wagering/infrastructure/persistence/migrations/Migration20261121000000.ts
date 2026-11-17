import { Migration } from '@mikro-orm/migrations';

export class Migration20261121000000 extends Migration {
  async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN result_balance_currency VARCHAR(3) NULL;');
    this.addSql('UPDATE wager_transactions SET result_balance_currency = currency WHERE result_balance IS NOT NULL;');
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_result_balance_currency
      CHECK ((result_balance IS NULL AND result_balance_currency IS NULL)
        OR (result_balance IS NOT NULL AND result_balance_currency IS NOT NULL));`);
  }

  async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wager_result_balance_currency;');
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN IF EXISTS result_balance_currency;');
  }
}
