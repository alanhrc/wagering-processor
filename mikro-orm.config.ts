import { defineConfig } from '@mikro-orm/postgresql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';

export default defineConfig({
  entities: ['./dist/**/*.entity.js'],
  entitiesTs: ['./src/**/*.entity.ts'],
  dbName: process.env.DB_POSTGRES_NAME || 'wagering_db',
  host: process.env.DB_POSTGRES_HOST || 'localhost',
  port: Number(process.env.DB_POSTGRES_PORT) || 5436,
  user: process.env.DB_POSTGRES_USER || 'postgres',
  password: process.env.DB_POSTGRES_PASSWORD || 'postgres',
  metadataProvider: TsMorphMetadataProvider,
  migrations: {
    path: './src/modules/wagering/infrastructure/persistence/migrations',
    pathTs: './src/modules/wagering/infrastructure/persistence/migrations',
  },
});
