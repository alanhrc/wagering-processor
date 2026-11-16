export const ACCESS_TOKEN_VERIFIER = Symbol('ACCESS_TOKEN_VERIFIER');

export interface AuthenticatedIdentity {
  id: string;
  email?: string;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AuthenticatedIdentity>;
}
