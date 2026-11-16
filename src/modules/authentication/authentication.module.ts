import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ACCESS_TOKEN_VERIFIER } from './application/access-token-verifier.port.js';
import { OidcAccessTokenVerifier } from './infrastructure/oidc-access-token.verifier.js';
import { oidcConfiguration } from './infrastructure/oidc.config.js';
import { AuthController } from './presentation/http/auth.controller.js';
import { AccessTokenGuard } from '../../shared/infrastructure/auth/access-token.guard.js';

@Module({
  controllers: [AuthController],
  providers: [
    { provide: ACCESS_TOKEN_VERIFIER, useFactory: () => new OidcAccessTokenVerifier(oidcConfiguration()) },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
})
export class AuthenticationModule {}
