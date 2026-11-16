import { Inject, Injectable } from '@nestjs/common';
import { AuthUser, AuthUserEmailAlreadyExistsError } from '../domain/auth-user.js';
import {
  ACCESS_TOKEN_ISSUER,
  AUTH_USER_REPOSITORY,
  PASSWORD_HASHER,
} from '../domain/authentication.ports.js';
import type { AuthUserRepository, AccessTokenIssuer, PasswordHasher } from '../domain/authentication.ports.js';

const MINIMUM_PASSWORD_LENGTH = 12;

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class InvalidRegistrationError extends Error {
  constructor() {
    super(`Email must be valid and password must contain at least ${MINIMUM_PASSWORD_LENGTH} characters`);
    this.name = 'InvalidRegistrationError';
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

@Injectable()
export class RegisterUserUseCase {
  constructor(
    @Inject(AUTH_USER_REPOSITORY) private readonly users: AuthUserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly tokens: AccessTokenIssuer,
  ) {}

  async execute(email: string, password: string): Promise<AuthenticatedUser> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!this.isValidEmail(normalizedEmail) || password.length < MINIMUM_PASSWORD_LENGTH) {
      throw new InvalidRegistrationError();
    }
    if (await this.users.findByEmail(normalizedEmail)) throw new AuthUserEmailAlreadyExistsError();

    const user = AuthUser.register(normalizedEmail, await this.passwords.hash(password));
    await this.users.create(user);
    return this.toAuthenticatedUser(user);
  }

  private async toAuthenticatedUser(user: AuthUser): Promise<AuthenticatedUser> {
    return {
      id: user.id,
      email: user.email,
      accessToken: await this.tokens.issue(user),
      tokenType: 'Bearer',
      expiresIn: 900,
    };
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}

@Injectable()
export class AuthenticateUserUseCase {
  constructor(
    @Inject(AUTH_USER_REPOSITORY) private readonly users: AuthUserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly tokens: AccessTokenIssuer,
  ) {}

  async execute(email: string, password: string): Promise<AuthenticatedUser> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    if (!user || !(await this.passwords.verify(user.passwordHash, password))) {
      throw new InvalidCredentialsError();
    }

    return {
      id: user.id,
      email: user.email,
      accessToken: await this.tokens.issue(user),
      tokenType: 'Bearer',
      expiresIn: 900,
    };
  }
}
