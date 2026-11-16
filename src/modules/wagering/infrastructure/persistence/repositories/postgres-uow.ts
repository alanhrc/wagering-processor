import { EntityManager } from '@mikro-orm/core';
import { IUnitOfWork } from '../../../domain/ports/wagering.repository.interface';

export class PostgresUnitOfWork implements IUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async transactional<T>(work: () => Promise<T>): Promise<T> {
    // Cria um fork limpo do EM para isolar a transação
    const fork = this.em.fork();
    return await fork.transactional(async () => {
      return await work();
    });
  }
}
