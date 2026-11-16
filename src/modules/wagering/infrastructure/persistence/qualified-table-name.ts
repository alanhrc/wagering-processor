import { EntityManager } from '@mikro-orm/core';

export function qualifiedTableName(em: EntityManager, tableName: string): string {
  const schema = em.config.getSchema();
  const quotedSchema = schema?.replaceAll('"', '""');

  return quotedSchema ? `"${quotedSchema}"."${tableName}"` : tableName;
}
