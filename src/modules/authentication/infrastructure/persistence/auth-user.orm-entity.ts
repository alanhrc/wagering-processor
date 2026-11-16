import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'auth_users' })
export class AuthUserOrmEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string', length: 320, unique: true })
  email!: string;

  @Property({ fieldName: 'password_hash', type: 'text', hidden: true })
  passwordHash!: string;

  @Property({ fieldName: 'created_at', type: 'datetime', default: 'NOW()' })
  createdAt: Date = new Date();
}
