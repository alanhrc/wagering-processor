import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';
import { SeedInitialUserUseCase } from '../src/modules/authentication/application/seed-initial-user.use-case.js';
import { PostgresAuthUserRepository } from '../src/modules/authentication/infrastructure/persistence/postgres-auth-user.repository.js';
import { Argon2PasswordHasher } from '../src/modules/authentication/infrastructure/argon2-password.hasher.js';

const email = process.env.AUTH_SEED_EMAIL;
const password = process.env.AUTH_SEED_PASSWORD;
if (!email || !password) throw new Error('Configure AUTH_SEED_EMAIL and AUTH_SEED_PASSWORD in .env before running seed:user');
const orm = await MikroORM.init(config);
try {
  const seed = new SeedInitialUserUseCase(new PostgresAuthUserRepository(orm.em), new Argon2PasswordHasher());
  await seed.execute(email, password);
  process.stdout.write('Initial user is available. Existing credentials were preserved.\n');
} finally {
  await orm.close(true);
}
