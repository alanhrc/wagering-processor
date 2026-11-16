import { Inject, Injectable } from '@nestjs/common';
import { AuthUser, AuthUserEmailAlreadyExistsError } from '../domain/auth-user.js';
import { AUTH_USER_REPOSITORY, PASSWORD_HASHER } from '../domain/authentication.ports.js';
import type { AuthUserRepository, PasswordHasher } from '../domain/authentication.ports.js';

@Injectable()
export class SeedInitialUserUseCase {
  constructor(
    @Inject(AUTH_USER_REPOSITORY) private readonly users: AuthUserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
  ) {}

  async execute(email: string | undefined, password: string | undefined): Promise<void> {
    if (!email && !password) return;
    if (!email || !password || password.length < 12 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      throw new Error('AUTH_SEED_EMAIL and AUTH_SEED_PASSWORD must both be set, and the password must have at least 12 characters');
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (await this.users.findByEmail(normalizedEmail)) return;

    const user = AuthUser.register(normalizedEmail, await this.passwords.hash(password));
    try {
      await this.users.create(user);
    } catch (error: unknown) {
      if (error instanceof AuthUserEmailAlreadyExistsError) return;
      throw error;
    }
  }
}
