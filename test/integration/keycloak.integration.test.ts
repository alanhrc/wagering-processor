import { describe, expect, it } from 'bun:test';
import { randomBytes, createHash } from 'node:crypto';
import { OidcAccessTokenVerifier } from '../../src/modules/authentication/infrastructure/oidc-access-token.verifier.js';
import { oidcConfiguration } from '../../src/modules/authentication/infrastructure/oidc.config.js';

interface TokenResponse { access_token: string }

async function readToken(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Keycloak token request failed: HTTP ${response.status}`);
  const value = await response.json() as TokenResponse;
  if (typeof value.access_token !== 'string') throw new Error('Missing Keycloak access token');
  return value.access_token;
}

describe('Keycloak integration', () => {
  it('provisions an initial account idempotently and authenticates it with Authorization Code and PKCE', async () => {
    const baseUrl = process.env.KEYCLOAK_BASE_URL || 'http://localhost:8080';
    const configuration = oidcConfiguration();
    const email = `integration-${crypto.randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const adminToken = await readToken(await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli',
        username: process.env.KEYCLOAK_ADMIN_USERNAME || '', password: process.env.KEYCLOAK_ADMIN_PASSWORD || '' }),
      signal: AbortSignal.timeout(10000),
    }));
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const usersUrl = `${baseUrl}/admin/realms/wagering/users`;
    try {
      const seed = async (seedPassword: string) => {
        const child = Bun.spawn([process.execPath, 'scripts/seed-user.ts'], {
          env: { ...process.env, AUTH_SEED_EMAIL: email, AUTH_SEED_PASSWORD: seedPassword },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        if (code !== 0) throw new Error(`Keycloak seed subprocess failed: ${errors}`);
      };
      await seed(password);
      await seed('a-different-password-that-must-not-replace-the-first');
      const userResponse = await fetch(`${usersUrl}?email=${encodeURIComponent(email)}&exact=true`, { headers: adminHeaders });
      const users = await userResponse.json() as Array<{ id: string }>;
      expect(users).toHaveLength(1);

      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomUUID();
      const redirectUri = process.env.KEYCLOAK_SWAGGER_REDIRECT_URI || 'http://localhost:3000/docs/oauth2-redirect.html';
      const authorizationUrl = new URL(`${configuration.issuer}/protocol/openid-connect/auth`);
      authorizationUrl.search = new URLSearchParams({
        client_id: configuration.swaggerClientId, response_type: 'code', scope: 'openid email profile',
        redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state,
      }).toString();
      const cookies = new Map<string, string>();
      const rememberCookies = (response: Response) => {
        for (const cookie of response.headers.getSetCookie()) {
          const value = cookie.split(';')[0]!;
          cookies.set(value.split('=')[0]!, value);
        }
      };
      const authorization = await fetch(authorizationUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      rememberCookies(authorization);
      const loginHtml = await authorization.text();
      const action = loginHtml.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
      if (!action) throw new Error(`Keycloak did not return a login form: HTTP ${authorization.status}`);
      const login = await fetch(action, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: [...cookies.values()].join('; ') },
        body: new URLSearchParams({ username: email, password, credentialId: '' }),
        signal: AbortSignal.timeout(10000),
      });
      const location = login.headers.get('location');
      if (!location) throw new Error(`Keycloak login did not redirect: HTTP ${login.status}`);
      const callback = new URL(location);
      expect(callback.searchParams.get('state')).toBe(state);
      const code = callback.searchParams.get('code');
      if (!code) throw new Error('Keycloak did not return an authorization code');
      const accessToken = await readToken(await fetch(`${configuration.issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: configuration.swaggerClientId,
          redirect_uri: redirectUri, code, code_verifier: verifier }),
        signal: AbortSignal.timeout(10000),
      }));
      const identity = await new OidcAccessTokenVerifier(configuration).verify(accessToken);
      expect(identity).toEqual({ id: users[0]!.id, email });
    } finally {
      const response = await fetch(`${usersUrl}?email=${encodeURIComponent(email)}&exact=true`, { headers: adminHeaders });
      expect(response.ok).toBe(true);
      const users = await response.json() as Array<{ id: string }>;
      for (const user of users) {
        const deleted = await fetch(`${usersUrl}/${user.id}`, { method: 'DELETE', headers: adminHeaders });
        expect(deleted.ok).toBe(true);
      }
    }
  }, 30000);
});
