import { randomUUID } from 'node:crypto';

export interface AuthUserState {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export class AuthUser {
  private constructor(
    public readonly id: string,
    public readonly email: string,
    public readonly passwordHash: string,
    public readonly createdAt: Date,
  ) {}

  static register(email: string, passwordHash: string): AuthUser {
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || !passwordHash) throw new InvalidAuthUserError();
    return new AuthUser(randomUUID(), normalizedEmail, passwordHash, new Date());
  }

  static rehydrate(state: AuthUserState): AuthUser {
    return new AuthUser(state.id, state.email, state.passwordHash, state.createdAt);
  }
}

export class AuthUserEmailAlreadyExistsError extends Error {
  constructor() {
    super('An account with this email already exists');
    this.name = 'AuthUserEmailAlreadyExistsError';
  }
}

export class InvalidAuthUserError extends Error {
  constructor() {
    super('A valid email and password hash are required');
    this.name = 'InvalidAuthUserError';
  }
}
