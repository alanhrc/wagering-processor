export {};

const baseUrl = process.env.KEYCLOAK_BASE_URL || 'http://localhost:8080';
const email = process.env.AUTH_SEED_EMAIL?.trim().toLowerCase();
const password = process.env.AUTH_SEED_PASSWORD;
const adminUsername = process.env.KEYCLOAK_ADMIN_USERNAME;
const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
if (!email || !password || password.length < 12 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('Configure AUTH_SEED_EMAIL and AUTH_SEED_PASSWORD (at least 12 characters) in .env');
}
if (!adminUsername || !adminPassword) throw new Error('Configure KEYCLOAK_ADMIN_USERNAME and KEYCLOAK_ADMIN_PASSWORD in .env');
const realmUrl = `${baseUrl}/admin/realms/wagering`;
const tokenResponse = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUsername, password: adminPassword }),
  signal: AbortSignal.timeout(10_000),
});
if (!tokenResponse.ok) throw new Error(`Keycloak administrator authentication failed: HTTP ${tokenResponse.status}`);
const tokenBody: unknown = await tokenResponse.json();
if (!tokenBody || typeof tokenBody !== 'object' || !('access_token' in tokenBody) || typeof tokenBody.access_token !== 'string') {
  throw new Error('Keycloak did not return an administrator token');
}
const headers = { authorization: `Bearer ${tokenBody.access_token}`, 'content-type': 'application/json' };
const existingResponse = await fetch(`${realmUrl}/users?email=${encodeURIComponent(email)}&exact=true`, { headers, signal: AbortSignal.timeout(10_000) });
if (!existingResponse.ok) throw new Error(`Keycloak user lookup failed: HTTP ${existingResponse.status}`);
const existing: unknown = await existingResponse.json();
if (!Array.isArray(existing)) throw new Error('Invalid Keycloak user lookup response');
if (existing.length === 0) {
  const response = await fetch(`${realmUrl}/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      username: email, email, enabled: true, firstName: 'Initial', lastName: 'User',
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201 && response.status !== 409) throw new Error(`Keycloak seed failed: HTTP ${response.status}`);
}
process.stdout.write('Initial Keycloak user is available. Existing credentials were preserved.\n');
