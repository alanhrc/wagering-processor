import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AuthUser } from '../src/modules/authentication/domain/auth-user.js';
import {
  ACCESS_TOKEN_ISSUER,
  AUTH_USER_REPOSITORY,
} from '../src/modules/authentication/domain/authentication.ports.js';
import type { AuthUserRepository } from '../src/modules/authentication/domain/authentication.ports.js';
import { AuthenticateUserUseCase, RegisterUserUseCase } from '../src/modules/authentication/application/authentication.use-cases.js';
import { AuthController } from '../src/modules/authentication/presentation/http/auth.controller.js';
import { Argon2PasswordHasher } from '../src/modules/authentication/infrastructure/argon2-password.hasher.js';
import { JwtAccessTokenIssuer } from '../src/modules/authentication/infrastructure/jwt-access-token.issuer.js';
import { AccessTokenGuard } from '../src/shared/infrastructure/auth/access-token.guard.js';
import { PASSWORD_HASHER } from '../src/modules/authentication/domain/authentication.ports.js';

class InMemoryAuthUserRepository implements AuthUserRepository {
  private readonly users = new Map<string, AuthUser>();

  async findByEmail(email: string): Promise<AuthUser | undefined> {
    return this.users.get(email);
  }

  async create(user: AuthUser): Promise<void> {
    this.users.set(user.email, user);
  }
}

describe('Authentication routes (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret-with-more-than-32-characters' })],
      controllers: [AuthController],
      providers: [
        { provide: AUTH_USER_REPOSITORY, useClass: InMemoryAuthUserRepository },
        { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
        { provide: ACCESS_TOKEN_ISSUER, useClass: JwtAccessTokenIssuer },
        RegisterUserUseCase,
        AuthenticateUserUseCase,
        AccessTokenGuard,
        { provide: APP_GUARD, useExisting: AccessTokenGuard },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers, authenticates and protects a session with a bearer token', async () => {
    const credentials = { email: '  Alan@example.com ', password: 'correct-horse-battery-staple' };
    const registration = await request(app.getHttpServer()).post('/auth/register').send(credentials).expect(201);

    expect(registration.body).toMatchObject({ email: 'alan@example.com', tokenType: 'Bearer', expiresIn: 900 });
    expect(registration.body.accessToken).toEqual(expect.any(String));
    expect(registration.body).not.toHaveProperty('passwordHash');

    await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(200);
    await request(app.getHttpServer()).post('/auth/session').expect(401);

    const session = await request(app.getHttpServer())
      .post('/auth/session')
      .set('Authorization', `Bearer ${registration.body.accessToken as string}`)
      .expect(200);

    expect(session.body).toMatchObject({ email: 'alan@example.com' });

    const expiredToken = await app.get(JwtService).signAsync(
      { sub: registration.body.id as string, email: 'alan@example.com' },
      { expiresIn: -1 },
    );
    await request(app.getHttpServer())
      .post('/auth/session')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
  });

  it('rejects duplicate registration, weak passwords and invalid credentials', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'alan@example.com', password: 'another-valid-password' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'invalid-email', password: 'short' })
      .expect(400);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'alan@example.com', password: 'wrong-password' })
      .expect(401);

    expect(response.body).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  });
});
