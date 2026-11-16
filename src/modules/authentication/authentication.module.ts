import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { AuthenticateUserUseCase, RegisterUserUseCase } from './application/authentication.use-cases.js';
import { SeedInitialUserUseCase } from './application/seed-initial-user.use-case.js';
import { ACCESS_TOKEN_ISSUER, AUTH_USER_REPOSITORY, PASSWORD_HASHER } from './domain/authentication.ports.js';
import { AuthUserOrmEntity } from './infrastructure/persistence/auth-user.orm-entity.js';
import { PostgresAuthUserRepository } from './infrastructure/persistence/postgres-auth-user.repository.js';
import { Argon2PasswordHasher } from './infrastructure/argon2-password.hasher.js';
import { JwtAccessTokenIssuer } from './infrastructure/jwt-access-token.issuer.js';
import { InitialUserSeeder } from './infrastructure/initial-user-seeder.js';
import { AuthController } from './presentation/http/auth.controller.js';
import { AccessTokenGuard } from '../../shared/infrastructure/auth/access-token.guard.js';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  return secret;
}

@Module({
  imports: [
    MikroOrmModule.forFeature([AuthUserOrmEntity]),
    JwtModule.register({ secret: jwtSecret(), signOptions: { expiresIn: '15m' } }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_USER_REPOSITORY,
      useFactory: (em: EntityManager) => new PostgresAuthUserRepository(em),
      inject: [EntityManager],
    },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: ACCESS_TOKEN_ISSUER, useClass: JwtAccessTokenIssuer },
    RegisterUserUseCase,
    AuthenticateUserUseCase,
    SeedInitialUserUseCase,
    InitialUserSeeder,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
})
export class AuthenticationModule {}
