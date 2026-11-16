import { Migration } from '@mikro-orm/migrations';

export class Migration20261115000000 extends Migration {

  async up(): Promise<void> {
    // 1. Tabela de Wallets com Constraint de Saldo Não-Negativo
    this.addSql(`
      CREATE TABLE wallets (
        id VARCHAR(36) PRIMARY KEY,
        player_id VARCHAR(36) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(15, 2) NOT NULL CHECK (balance >= 0),
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_player_currency UNIQUE (player_id, currency)
      );
    `);

    // 2. Tabela de Transações de Apostas
    this.addSql(`
      CREATE TABLE wager_transactions (
        id VARCHAR(36) PRIMARY KEY,
        provider_id VARCHAR(50) NOT NULL,
        external_transaction_id VARCHAR(100) NOT NULL,
        idempotency_key VARCHAR(150) NOT NULL UNIQUE,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id),
        player_id VARCHAR(36) NOT NULL,
        round_id VARCHAR(50) NOT NULL,
        game_id VARCHAR(50) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        status VARCHAR(20) NOT NULL,
        reference_external_transaction_id VARCHAR(100),
        reference_transaction_id VARCHAR(36) REFERENCES wager_transactions(id),
        failure_code VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP WITH TIME ZONE
      );
    `);

    // 3. Tabela de Ledger (Imutável: proibido alterar ou excluir por regra de negócio)
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id VARCHAR(36) PRIMARY KEY,
        wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id),
        transaction_id VARCHAR(36) NOT NULL REFERENCES wager_transactions(id),
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(15, 2) NOT NULL,
        balance_after NUMERIC(15, 2) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Trigger / Regra de Banco para Imutabilidade do Ledger (Inviolável)
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are immutable and cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_prevent_ledger_update_delete
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_mutation();
    `);

    // 5. Tabela de Inbox (Deduplicação de Mensagens SQS)
    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id VARCHAR(100) NOT NULL,
        consumer_name VARCHAR(100) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP WITH TIME ZONE,
        PRIMARY KEY (message_id, consumer_name)
      );
    `);

    // 6. Tabela de Outbox (Transactional Outbox Pattern)
    this.addSql(`
      CREATE TABLE outbox_messages (
        id VARCHAR(36) PRIMARY KEY,
        aggregate_id VARCHAR(36) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
        published_at TIMESTAMP WITH TIME ZONE,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP WITH TIME ZONE
      );
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_prevent_ledger_update_delete ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_ledger_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
