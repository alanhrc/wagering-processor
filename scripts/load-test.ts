import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';

interface HttpResult<T> {
  status: number;
  body: T;
  durationMs: number;
}

interface AuthenticatedUser {
  access_token: string;
}

interface WalletResponse {
  id: string;
  balance: { amount: string; currency: string };
}

interface MetricSnapshot {
  lockConflicts: number;
  outboxLagSeconds: number;
}

interface LoadResult {
  status: number;
  latencyMs: number;
  error?: string;
}

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const keepSchema = process.env.KEEP_TEST_SCHEMA === 'true';
const schemaName = `wagering_load_${randomUUID().replaceAll('-', '')}`;
const runId = randomUUID().replaceAll('-', '');
const queueNames = {
  deadLetter: `wager-load-dlq-${runId}.fifo`,
  wagers: `wager-load-input-${runId}.fifo`,
  events: `wager-load-events-${runId}.fifo`,
};
const queueUrls: string[] = [];
const sqsEndpoint = process.env.AWS_SQS_ENDPOINT || 'http://localhost:4566';
const sqs = new SQSClient({
  region: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
  endpoint: sqsEndpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
});
let orm: MikroORM | undefined;
let application: ReturnType<typeof spawn> | undefined;
let schemaCreated = false;
let applicationStopped = false;
let queuesDeleted = false;
let schemaDropped = false;
let pendingReport: Record<string, unknown> | undefined;
let pendingReportPath: string | undefined;

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]?.trim() || undefined;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function assertLocalTargets(): void {
  if (process.env.LOAD_TEST_CONFIRM_LOCAL !== 'YES') {
    throw new Error('Set LOAD_TEST_CONFIRM_LOCAL=YES to run this benchmark against local dependencies.');
  }
  const databaseHost = (process.env.DB_POSTGRES_HOST || 'localhost').toLowerCase();
  const endpointHost = new URL(sqsEndpoint).hostname.toLowerCase();
  if (!localHosts.has(databaseHost) || !localHosts.has(endpointHost)) {
    throw new Error('The load test only permits PostgreSQL and SQS endpoints on localhost.');
  }
}

async function createQueue(name: string, attributes: Record<string, string>): Promise<string> {
  const response = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (!response.QueueUrl) throw new Error(`LocalStack did not return a QueueUrl for ${name}`);
  queueUrls.push(response.QueueUrl);
  return response.QueueUrl;
}

async function createQueues(): Promise<{ wagersUrl: string; deadLetterUrl: string; eventsUrl: string }> {
  const deadLetterUrl = await createQueue(queueNames.deadLetter, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
  });
  const deadLetterAttributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetterUrl, AttributeNames: ['QueueArn'] }),
  );
  const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
  if (!deadLetterArn) throw new Error('LocalStack did not return the dead-letter queue ARN');
  const wagersUrl = await createQueue(queueNames.wagers, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadLetterArn, maxReceiveCount: 3 }),
  });
  const eventsUrl = await createQueue(queueNames.events, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
  });
  return { wagersUrl, deadLetterUrl, eventsUrl };
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to allocate a local HTTP port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function request<T>(url: string, init?: RequestInit): Promise<HttpResult<T>> {
  const startedAt = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T, durationMs: performance.now() - startedAt };
}

function readMetric(metrics: string, name: string): number {
  const line = metrics.split('\n').find((entry) => entry.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
}

async function readMetrics(baseUrl: string): Promise<MetricSnapshot> {
  const response = await request<string>(`${baseUrl}/metrics`);
  if (response.status !== 200 || typeof response.body !== 'string') {
    throw new Error(`Could not scrape metrics: HTTP ${response.status}`);
  }
  return {
    lockConflicts: readMetric(response.body, 'wagering_database_lock_conflicts_total'),
    outboxLagSeconds: readMetric(response.body, 'wagering_outbox_oldest_unpublished_seconds'),
  };
}

async function waitForApplication(baseUrl: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Application exited during startup with code ${child.exitCode}`);
    try {
      const health = await request<{ status?: string }>(`${baseUrl}/health/ready`);
      if (health.status === 200 && health.body.status === 'ok') return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    }
  }
  throw new Error('Application did not become ready within 60 seconds');
}

async function stopApplication(): Promise<void> {
  if (!application || application.exitCode !== null) {
    applicationStopped = true;
    return;
  }
  const child = application;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  const timeout = new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 10_000));
  await Promise.race([exited, timeout]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  applicationStopped = true;
}

async function deleteQueues(): Promise<void> {
  const outcomes = await Promise.allSettled(
    queueUrls.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))),
  );
  queuesDeleted = outcomes.every((outcome) => outcome.status === 'fulfilled');
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(fraction * ordered.length) - 1] ?? 0;
}

async function main(): Promise<void> {
  assertLocalTargets();
  const requests = positiveInteger('LOAD_TEST_REQUESTS', 500, 10_000);
  const concurrency = positiveInteger('LOAD_TEST_CONCURRENCY', 25, 100);
  const warmupRequests = positiveInteger('LOAD_TEST_WARMUP_REQUESTS', 10, 1_000);
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const queues = await createQueues();

  orm = await MikroORM.init({
    ...config,
    schema: schemaName,
    migrations: { ...config.migrations, snapshot: false },
  });
  await orm.em.getConnection().execute(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  schemaCreated = true;
  await orm.migrator.up({ schema: schemaName });
  await orm.close(true);
  orm = undefined;

  application = spawn(process.execPath, ['src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_POSTGRES_SCHEMA: schemaName,
      AWS_SQS_QUEUE_URL: queues.wagersUrl,
      AWS_SQS_DLQ_QUEUE_URL: queues.deadLetterUrl,
      AWS_SQS_EVENTS_QUEUE_URL: queues.eventsUrl,
      AWS_SQS_ENDPOINT: sqsEndpoint,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitForApplication(baseUrl, application);

  const issuer = process.env.OIDC_ISSUER;
  const clientSecret = process.env.KEYCLOAK_LOAD_CLIENT_SECRET;
  if (!issuer || !clientSecret) throw new Error('Configure OIDC_ISSUER and KEYCLOAK_LOAD_CLIENT_SECRET in .env');
  const authentication = await request<AuthenticatedUser>(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'wagering-load', client_secret: clientSecret }),
  });
  if (authentication.status !== 200 || typeof authentication.body.access_token !== 'string') {
    throw new Error(`Keycloak client credentials authentication failed: HTTP ${authentication.status}`);
  }
  const token = authentication.body.access_token;
  const playerId = randomUUID();
  const createdWallet = await request<WalletResponse>(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } }),
  });
  if (createdWallet.status !== 201 || typeof createdWallet.body.id !== 'string') {
    throw new Error(`Could not create load-test wallet: HTTP ${createdWallet.status}`);
  }
  const walletId = createdWallet.body.id;

  const submitWager = async (index: number): Promise<LoadResult> => {
    const operationId = `${runId}-${index}`;
    try {
      const result = await request<{ status?: string }>(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `load:${operationId}`,
          'x-correlation-id': `load:${operationId}`,
        },
        body: JSON.stringify({
          providerId: 'load-test-provider',
          externalTransactionId: operationId,
          playerId,
          walletId,
          roundId: `round-${operationId}`,
          gameId: 'load-test-game',
          kind: 'BET',
          money: { amount: '0.01', currency: 'BRL' },
        }),
      });
      return {
        status: result.status,
        latencyMs: result.durationMs,
        ...(result.status !== 200 ? { error: `HTTP ${result.status}` } : {}),
      };
    } catch (error: unknown) {
      return {
        status: 0,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'Unknown request failure',
      };
    }
  };

  for (let index = 0; index < warmupRequests; index += 1) {
    const result = await submitWager(-index - 1);
    if (result.status !== 200) throw new Error(`Warm-up request failed: ${result.error ?? result.status}`);
  }

  const before = await readMetrics(baseUrl);
  let maximumOutboxLag = before.outboxLagSeconds;
  let polling = true;
  const sampler = (async () => {
    while (polling) {
      try {
        const sample = await readMetrics(baseUrl);
        maximumOutboxLag = Math.max(maximumOutboxLag, sample.outboxLagSeconds);
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  })();

  const startedAt = performance.now();
  const results: LoadResult[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= requests) return;
      results.push(await submitWager(index));
    }
  });
  await Promise.all(workers);
  const elapsedMs = performance.now() - startedAt;
  polling = false;
  await sampler;
  const after = await readMetrics(baseUrl);
  const reconciliation = await request<{ consistent?: boolean; checkedEntries?: number }>(
    `${baseUrl}/wallets/${walletId}/reconciliation`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
  const finalWallet = await request<WalletResponse>(`${baseUrl}/wallets/${walletId}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  const latencies = results.map(({ latencyMs }) => latencyMs);
  const failures = results.filter(({ status }) => status !== 200);
  const expectedBalanceCents = 100_000n - BigInt(warmupRequests + results.length - failures.length);
  const expectedBalance = `${expectedBalanceCents / 100n}.${(expectedBalanceCents % 100n).toString().padStart(2, '0')}`;
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      runtime: `Bun ${Bun.version}`,
      platform: `${process.platform}/${process.arch}`,
      cpuCount: navigator.hardwareConcurrency,
      memoryBytes: process.memoryUsage().rss,
      postgresHost: process.env.DB_POSTGRES_HOST || 'localhost',
      postgresPort: Number(process.env.DB_POSTGRES_PORT || 5436),
      postgresDatabase: process.env.DB_POSTGRES_NAME || 'wagering_db',
      schema: schemaName,
      schemaRetained: keepSchema,
      sqsEndpointHost: new URL(sqsEndpoint).hostname,
      queueNames,
    },
    methodology: {
      endpoint: 'POST /wagering/transactions',
      operation: 'BET of 0.01 BRL per request against one shared wallet opened at 1000.00 BRL',
      financialWrites: 'Each accepted request debits the wallet and appends one immutable ledger entry.',
      authentication: 'Keycloak service account using client_credentials and an RS256 access token',
      idempotency: 'Unique Idempotency-Key per measured request',
      requests,
      warmupRequests,
      concurrency,
      note: 'This is a local benchmark; the challenge defines no target RPS.',
    },
    results: {
      completed: results.length,
      succeeded: results.length - failures.length,
      failed: failures.length,
      errorRate: results.length === 0 ? 0 : failures.length / results.length,
      throughputRequestsPerSecond: elapsedMs === 0 ? 0 : results.length / (elapsedMs / 1_000),
      durationMs: elapsedMs,
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        min: Math.min(...latencies),
        max: Math.max(...latencies),
      },
      statusCounts: Object.fromEntries(
        [...new Set(results.map(({ status }) => status))].map((status) => [
          String(status),
          results.filter((result) => result.status === status).length,
        ]),
      ),
      sampleErrors: failures.slice(0, 10).map(({ status, error }) => ({ status, error })),
      databaseLockConflictDelta: after.lockConflicts - before.lockConflicts,
      outboxLagSeconds: {
        before: before.outboxLagSeconds,
        maximumSampled: maximumOutboxLag,
        after: after.outboxLagSeconds,
      },
      reconciliation: {
        httpStatus: reconciliation.status,
        consistent: reconciliation.body.consistent ?? false,
        checkedEntries: reconciliation.body.checkedEntries ?? 0,
      },
      wallet: {
        httpStatus: finalWallet.status,
        expectedBalance: { amount: expectedBalance, currency: 'BRL' },
        actualBalance: finalWallet.body.balance ?? null,
        matchesExpectedBalance: finalWallet.status === 200 && finalWallet.body.balance?.amount === expectedBalance,
      },
    },
    cleanup: {
      schemaDropped: false,
      queuesDeleted: false,
      applicationStopped: false,
    },
  };

  pendingReportPath = resolve(
    process.env.LOAD_TEST_REPORT_PATH || `reports/load-tests/load-${new Date().toISOString().replaceAll(':', '-')}.json`,
  );
  pendingReport = report;
  if (
    failures.length > 0 ||
    reconciliation.status !== 200 ||
    !reconciliation.body.consistent ||
    finalWallet.status !== 200 ||
    finalWallet.body.balance?.amount !== expectedBalance
  ) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await stopApplication().catch((error: unknown) => {
    process.stderr.write(`Failed to stop load-test application: ${String(error)}\n`);
    process.exitCode = 1;
  });
  if (orm) await orm.close(true).catch(() => undefined);
  if (schemaCreated && !keepSchema) {
    const cleanupOrm = await MikroORM.init({ ...config, schema: 'public' }).catch(() => undefined);
    if (cleanupOrm) {
      try {
        await cleanupOrm.em.getConnection().execute(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        schemaDropped = true;
      } catch (error: unknown) {
        process.stderr.write(`Failed to drop isolated schema ${schemaName}: ${String(error)}\n`);
        process.exitCode = 1;
      }
      await cleanupOrm.close(true);
    } else {
      process.stderr.write(`Could not connect to PostgreSQL to drop isolated schema ${schemaName}\n`);
      process.exitCode = 1;
    }
  }
  await deleteQueues().catch((error: unknown) => {
    process.stderr.write(`Failed to delete load-test queues: ${String(error)}\n`);
    process.exitCode = 1;
  });
  sqs.destroy();
  if (pendingReport && pendingReportPath) {
    const cleanup = pendingReport.cleanup as Record<string, unknown>;
    cleanup.schemaDropped = schemaDropped;
    cleanup.queuesDeleted = queuesDeleted;
    cleanup.applicationStopped = applicationStopped;
    await mkdir(dirname(pendingReportPath), { recursive: true });
    await writeFile(pendingReportPath, `${JSON.stringify(pendingReport, null, 2)}\n`, 'utf8');
    const results = pendingReport.results;
    process.stdout.write(
      `${JSON.stringify({ reportPath: pendingReportPath, ...(typeof results === 'object' && results !== null ? results : {}) }, null, 2)}\n`,
    );
  }
}
