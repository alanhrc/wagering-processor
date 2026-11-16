import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ACCESS_TOKEN_VERIFIER } from '../src/modules/authentication/application/access-token-verifier.port.js';
import { OidcAccessTokenVerifier } from '../src/modules/authentication/infrastructure/oidc-access-token.verifier.js';
import { AuthController } from '../src/modules/authentication/presentation/http/auth.controller.js';
import { AccessTokenGuard } from '../src/shared/infrastructure/auth/access-token.guard.js';
import { HealthController } from '../src/modules/wagering/presentation/http/health.controller.js';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';

const issuer = 'https://identity.example.test/realms/wagering';
const audience = 'wagering-api';

describe('OIDC authentication (e2e)', () => {
  let app: INestApplication;
  let jwksServer: ReturnType<typeof Bun.serve>;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
    jwksServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [jwk] }) });
    const verifier = new OidcAccessTokenVerifier({ issuer, audience, jwksUri: `${jwksServer.url}certs`, swaggerClientId: 'test' });
    const module = await Test.createTestingModule({
      controllers: [AuthController, HealthController],
      providers: [
        { provide: ACCESS_TOKEN_VERIFIER, useValue: verifier },
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: EntityManager, useValue: {} },
        { provide: SQSClient, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (jwksServer) await jwksServer.stop(true);
  });

  const token = (overrides: { issuer?: string; audience?: string; expiration?: number; typ?: string } = {}) =>
    new SignJWT({ email: 'alan@example.test', typ: overrides.typ ?? 'Bearer' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('external-user-id')
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.expiration ?? Math.floor(Date.now() / 1000) + 60)
      .sign(keys.privateKey);

  it('verifies an external signature through JWKS and exposes the subject', async () => {
    const response = await request(app.getHttpServer()).get('/auth/session')
      .set('Authorization', `Bearer ${await token()}`).expect(200);
    expect(response.body).toEqual({ userId: 'external-user-id', email: 'alan@example.test' });
  });

  it('rejects missing, malformed and tampered bearer tokens', async () => {
    await request(app.getHttpServer()).get('/auth/session').expect(401);
    await request(app.getHttpServer()).get('/auth/session').set('Authorization', 'Bearer invalid').expect(401);
    const signed = await token();
    const [header, payload, signature] = signed.split('.');
    const altered = `${header}.${payload}.${signature?.startsWith('A') ? 'B' : 'A'}${signature?.slice(1)}`;
    await request(app.getHttpServer()).get('/auth/session').set('Authorization', `Bearer ${altered}`).expect(401);
  });

  it.each([
    { issuer: 'https://another.example.test' },
    { audience: 'another-api' },
    { expiration: Math.floor(Date.now() / 1000) - 60 },
    { typ: 'ID' },
  ])('rejects incorrect issuer, audience, expiration or token type: %j', async (overrides) => {
    await request(app.getHttpServer()).get('/auth/session')
      .set('Authorization', `Bearer ${await token(overrides)}`).expect(401);
  });

  it('keeps health public and delegates registration and login to the IdP', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).post('/auth/login').expect(404);
    await request(app.getHttpServer()).post('/auth/register').expect(404);
  });
});
