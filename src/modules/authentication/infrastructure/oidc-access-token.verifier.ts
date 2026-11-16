import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AccessTokenVerifier, AuthenticatedIdentity } from '../application/access-token-verifier.port.js';
import type { OidcConfiguration } from './oidc.config.js';

export class OidcAccessTokenVerifier implements AccessTokenVerifier {
  private readonly keys;

  constructor(private readonly configuration: OidcConfiguration) {
    this.keys = createRemoteJWKSet(new URL(configuration.jwksUri), { timeoutDuration: 5_000 });
  }

  async verify(token: string): Promise<AuthenticatedIdentity> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.configuration.issuer,
      audience: this.configuration.audience,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (!payload.sub || payload.typ !== 'Bearer') throw new Error('Expected an OIDC access token');
    return { id: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
  }
}
