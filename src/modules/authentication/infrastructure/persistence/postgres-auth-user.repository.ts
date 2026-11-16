import { EntityManager } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { AuthUser, AuthUserEmailAlreadyExistsError, AuthUserState } from '../../domain/auth-user.js';
import { AuthUserRepository } from '../../domain/authentication.ports.js';
import { AuthUserOrmEntity } from './auth-user.orm-entity.js';

export class PostgresAuthUserRepository implements AuthUserRepository {
  constructor(private readonly em: EntityManager) {}

  async findByEmail(email: string): Promise<AuthUser | undefined> {
    const em = this.em.fork();
    const entity = await em.findOne(AuthUserOrmEntity, { email });
    if (!entity) return undefined;
    return AuthUser.rehydrate({
      id: entity.id,
      email: entity.email,
      passwordHash: entity.passwordHash,
      createdAt: entity.createdAt,
    } satisfies AuthUserState);
  }

  async create(user: AuthUser): Promise<void> {
    const em = this.em.fork();
    const entity = em.create(AuthUserOrmEntity, {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      createdAt: user.createdAt,
    });
    em.persist(entity);
    try {
      await em.flush();
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) throw new AuthUserEmailAlreadyExistsError();
      throw error;
    }
  }
}
