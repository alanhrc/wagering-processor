import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { oidcConfiguration } from './modules/authentication/infrastructure/oidc.config.js';

export function configureSwagger(app: INestApplication): void {
  const oidc = oidcConfiguration();
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor API')
    .setDescription('Wallet and wager API. Authenticate with Keycloak using Authorization Code with PKCE.')
    .setVersion('1.0.0')
    .addOAuth2({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: `${oidc.issuer}/protocol/openid-connect/auth`,
          tokenUrl: `${oidc.issuer}/protocol/openid-connect/token`,
          scopes: { openid: 'OpenID Connect identity', email: 'Email address', profile: 'User profile' },
        },
      },
    }, 'bearer')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Wagering Processor API',
    swaggerOptions: { oauth: { clientId: oidc.swaggerClientId, usePkceWithAuthorizationCodeGrant: true, scopes: 'openid email profile' } },
  });
}
