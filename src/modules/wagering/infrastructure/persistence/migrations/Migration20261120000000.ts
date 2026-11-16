import { Migration } from '@mikro-orm/migrations';

export class Migration20261120000000 extends Migration {
  async up(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS auth_users;');
  }

  async down(): Promise<void> {
    this.addSql(`CREATE TABLE auth_users (
      id UUID PRIMARY KEY,
      email VARCHAR(320) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT auth_users_email_normalized CHECK (email = LOWER(BTRIM(email)))
    );`);
  }
}
