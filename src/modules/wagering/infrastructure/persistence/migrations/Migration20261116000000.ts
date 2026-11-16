import { Migration } from '@mikro-orm/migrations';

export class Migration20261116000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN attempts INT NOT NULL DEFAULT 0;`);
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN next_attempt_at TIMESTAMP WITH TIME ZONE NULL;`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_transaction_amount_positive CHECK (amount > 0);`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_transaction_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_transaction_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ck_wallet_ledger_amount_positive CHECK (amount > 0);`);
    this.addSql(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ck_wallet_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT'));`);
    this.addSql(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ck_wallet_ledger_balances_nonnegative CHECK (balance_before >= 0 AND balance_after >= 0);`);
    this.addSql(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ck_wallet_ledger_arithmetic CHECK ((direction = 'DEBIT' AND balance_after = balance_before - amount) OR (direction = 'CREDIT' AND balance_after = balance_before + amount));`);
    this.addSql(`CREATE UNIQUE INDEX uk_wallet_ledger_transaction_wallet ON wallet_ledger_entries (transaction_id, wallet_id);`);
    this.addSql(`CREATE UNIQUE INDEX uk_wager_provider_external_id ON wager_transactions (provider_id, external_transaction_id);`);
    this.addSql(`CREATE INDEX ix_wager_pending_references_due ON wager_transactions (next_attempt_at, created_at) WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`-- Only one successful REFUND or ROLLBACK may reference an original transaction.
      CREATE UNIQUE INDEX uk_wager_single_successful_reversal
      ON wager_transactions (provider_id, reference_external_transaction_id)
      WHERE status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK')
        AND reference_external_transaction_id IS NOT NULL;`);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS uk_wager_single_successful_reversal;`);
    this.addSql(`DROP INDEX IF EXISTS ix_wager_pending_references_due;`);
    this.addSql(`DROP INDEX IF EXISTS uk_wager_provider_external_id;`);
    this.addSql(`DROP INDEX IF EXISTS uk_wallet_ledger_transaction_wallet;`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ck_wallet_ledger_arithmetic;`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ck_wallet_ledger_balances_nonnegative;`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ck_wallet_ledger_direction;`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ck_wallet_ledger_amount_positive;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wager_transaction_status;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wager_transaction_kind;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wager_transaction_amount_positive;`);
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN IF EXISTS next_attempt_at;`);
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN IF EXISTS attempts;`);
  }
}
