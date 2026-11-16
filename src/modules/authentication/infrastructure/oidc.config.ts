export interface OidcConfiguration {
  issuer: string;
  audience: string;
  jwksUri: string;
  swaggerClientId: string;
}

export function oidcConfiguration(): OidcConfiguration {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, '');
  const audience = process.env.OIDC_AUDIENCE;
  if (!issuer || !audience) throw new Error('OIDC_ISSUER and OIDC_AUDIENCE are required');
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname)) {
    throw new Error('Remote OIDC issuers must use HTTPS');
  }
  return {
    issuer,
    audience,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    swaggerClientId: process.env.OIDC_SWAGGER_CLIENT_ID || 'wagering-swagger',
  };
}
