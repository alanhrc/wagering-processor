import { describe, expect, it, vi } from 'vitest';
import { AuthUser, AuthUserEmailAlreadyExistsError } from '../domain/auth-user.js';
import { SeedInitialUserUseCase } from './seed-initial-user.use-case.js';

function createUseCase(existingUser?: AuthUser) {
  const users = {
    findByEmail: vi.fn().mockResolvedValue(existingUser),
    create: vi.fn().mockResolvedValue(undefined),
  };
  const passwords = {
    hash: vi.fn().mockResolvedValue('argon2id-hash'),
    verify: vi.fn(),
  };
  return { useCase: new SeedInitialUserUseCase(users, passwords), users, passwords };
}

describe('SeedInitialUserUseCase', () => {
  it('creates a normalized user with a password hash when both seed values are configured', async () => {
    const { useCase, users, passwords } = createUseCase();

    await useCase.execute('  ALAN@example.com  ', 'a-strong-seed-password');

    expect(users.findByEmail).toHaveBeenCalledWith('alan@example.com');
    expect(passwords.hash).toHaveBeenCalledWith('a-strong-seed-password');
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alan@example.com', passwordHash: 'argon2id-hash' }),
    );
  });

  it('does nothing when neither seed value is configured', async () => {
    const { useCase, users, passwords } = createUseCase();

    await useCase.execute(undefined, undefined);

    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(users.create).not.toHaveBeenCalled();
  });

  it.each([
    ['only an email', 'alan@example.com', undefined],
    ['only a password', undefined, 'a-strong-seed-password'],
    ['an invalid email', 'invalid-email', 'a-strong-seed-password'],
    ['a short password', 'alan@example.com', 'short'],
  ])('rejects invalid configuration when it contains %s', async (_case, email, password) => {
    const { useCase, users, passwords } = createUseCase();

    await expect(useCase.execute(email, password)).rejects.toThrow(
      'AUTH_SEED_EMAIL and AUTH_SEED_PASSWORD must both be set',
    );
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(users.create).not.toHaveBeenCalled();
  });

  it('does not rehash or overwrite an existing user', async () => {
    const existingUser = AuthUser.register('alan@example.com', 'existing-hash');
    const { useCase, users, passwords } = createUseCase(existingUser);

    await useCase.execute('alan@example.com', 'a-different-seed-password');

    expect(users.findByEmail).toHaveBeenCalledWith('alan@example.com');
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(users.create).not.toHaveBeenCalled();
  });

  it('treats a concurrent insert of the same email as an already completed seed', async () => {
    const { useCase, users } = createUseCase();
    users.create = vi.fn().mockRejectedValueOnce(new AuthUserEmailAlreadyExistsError());

    await expect(useCase.execute('alan@example.com', 'a-strong-seed-password')).resolves.toBeUndefined();
  });
});
