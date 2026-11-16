import { AuthUser } from './auth-user.js';

export const AUTH_USER_REPOSITORY = Symbol('AUTH_USER_REPOSITORY');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const ACCESS_TOKEN_ISSUER = Symbol('ACCESS_TOKEN_ISSUER');

export interface AuthUserRepository {
  findByEmail(email: string): Promise<AuthUser | undefined>;
  create(user: AuthUser): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export interface AccessTokenIssuer {
  issue(user: Pick<AuthUser, 'id' | 'email'>): Promise<string>;
}
