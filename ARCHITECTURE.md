# Architecture Decisions

## Scope

The service processes provider wager operations while keeping the wallet balance, immutable ledger, idempotency record, inbox, and integration events consistent across retries and concurrent application instances.

## Technology and boundaries

- Runtime and package manager: Bun 1.x.
- HTTP framework: NestJS with TypeScript strict mode.
- Persistence and transactions: PostgreSQL with MikroORM.
- Broker: AWS SQS; LocalStack supplies the local implementation.
- Domain code owns money, wallet, wager, ledger, and event rules. Application use cases coordinate ports. Infrastructure implements PostgreSQL and SQS adapters. HTTP controllers map transport contracts to use cases.
- Migrations are versioned under `src/modules/wagering/infrastructure/persistence/migrations` and provide reversible `up`/`down` changes.

## Money representation

`Money` stores amounts as integer cents in a `bigint` and serializes `amount` as a fixed two-decimal string. PostgreSQL stores the persisted amount in `NUMERIC(15, 2)` columns. JavaScript `number` is not used for monetary arithmetic. The model accepts currencies, while the challenge examples and local workflows use BRL.

## Wallet consistency and concurrency

Every balance-changing operation runs in one PostgreSQL transaction. The unit of concurrency is one wallet: the repository loads the wallet with a pessimistic write lock, then applies the domain transition and persists the wallet and ledger entry together. Separate wallets can progress concurrently. Database unique constraints, checks, and immutable ledger triggers preserve invariants even when multiple processes are running.

The opening balance is represented by an internal `OPENING` transaction and a credit ledger entry in the same transaction as wallet creation. A `LOSS` records a processed wager but does not change the balance or create a ledger row.

## Idempotency

The required `Idempotency-Key` is stored persistently. The payload hash is SHA-256 over canonical JSON with recursively sorted keys and only business fields; transport headers are excluded. A repeated key with the same hash returns the stored result. A repeated key with a different hash is a conflict. PostgreSQL uniqueness and transaction-scoped advisory locking coordinate concurrent requests across processes.

The persisted result balance allows a replay to return the original observed balance rather than a later wallet balance.

## Reversals and out-of-order references

`REFUND` and `ROLLBACK` require a reference and validate provider, player, wallet, currency, round, kind, and amount. A wallet lock serializes reversals against the same wallet.

The challenge permits one reversal per type but leaves cross-type behavior unspecified. The selected business rule is stricter: **a referenced transaction may have only one successful reversal total across `REFUND` and `ROLLBACK`**. This avoids applying two economically equivalent corrections to the same operation. Reversal attempts that would make the balance negative are persisted as rejected with `REVERSAL_INSUFFICIENT_FUNDS`.

Missing or not-yet-processed references remain `PENDING_REFERENCE`. A worker retries them with exponential delay, beginning at two seconds and capped at five minutes. After ten attempts, the transaction is rejected with a reference failure code and an outbox event.

## Inbox, outbox, and delivery

For SQS input, inbox insertion, wager processing, ledger updates, wallet changes, outbox events, and inbox completion share one SQL transaction. The consumer ACKs only after commit. A duplicate inbox message with the same hash is ACKed without repeating work; reusing its message ID with different content is treated as invalid and is eligible for redrive.

The outbox publisher reserves due rows using `FOR UPDATE SKIP LOCKED` and a 60-second lease. It publishes outside the reservation transaction, then marks success or schedules an exponential retry capped at five minutes. An expired lease can be reclaimed by another publisher after a crash. SQS publication is at-least-once; consumers should deduplicate by event ID.

The local queues are created by `scripts/localstack/init-sqs.sh`. The input FIFO queue points to `wager-transactions-dlq.fifo` after three receives. `wager-events.fifo` receives outbox events.

## HTTP status mapping

- `200`: processed result or idempotent replay.
- `202`: accepted while waiting for a referenced transaction.
- `400`: invalid request, money value, required header, or missing reversal reference.
- `404`: wallet or transaction not found.
- `409`: idempotency key or uniqueness conflict.
- `422`: business rule rejection, with a stable `failureCode`.
- `500`: unexpected processing failure.
- `503`: readiness dependency check failed.

## Authentication decision

The service delegates human authentication and account management to Keycloak, following the challenge's IdP expectation. The API acts as an OAuth resource server. `AuthenticationModule` binds an `AccessTokenVerifier` port to the `jose` adapter; the global guard consumes only the port. Domain money and wagering rules have no dependency on identity infrastructure.

The public Swagger client uses Authorization Code with PKCE S256. It has an exact redirect URI, no client secret and no direct password grant. Keycloak manages registration and login; the API exposes only `GET /auth/session`. `jose` resolves keys from the configured issuer's JWKS endpoint and caches them, validates RS256 signature, exact issuer, API audience, expiration, issued-at and subject, and requires a Bearer access token. An ID token is not accepted as an API access token. Health and metrics remain public.

The `wagering-load` confidential client uses client credentials for a service account. An audience mapper includes `wagering-api` in access tokens. Its secret remains in `.env` and is substituted during realm import. This flow represents a machine, not a human login. All identities accepted for this audience currently share business endpoint access; tenant/ownership authorization remains an explicit extension.

`bun run seed:user` provisions a human account through the Keycloak Admin API using the configured bootstrap administrator. It looks up the normalized email and does not replace an existing password; a concurrent creation conflict is treated as already provisioned. The setup script uses `admin-cli` to obtain an administrative token locally; this is not the Swagger login flow. Production provisioning should use a narrowly scoped administrative service account.

Keycloak runs in development mode with data under `.volumes/keycloak` and imports the versioned realm on first creation. Existing realms are not overwritten by startup import. Rotating client or admin secrets in `.env` alone does not update persisted credentials. For production, use HTTPS, a supported external Keycloak database, backups and explicit identity access policies. The new migration removes the former application-owned users table; `down` restores its structure, not deleted account data. Existing users must be provisioned in the IdP.

## Observability

Application logs use Nest's JSON console logger. Wager processing, SQS delivery, outbox retries, wallet creation, and reconciliation mismatch logs include relevant IDs and omit financial amounts and complete payloads. The logger redacts common monetary and secret field names.

`GET /metrics` exposes Prometheus text format:

| Metric | Meaning |
|---|---|
| `wagering_transactions_total{status}` | Processing results by transaction status. |
| `wagering_duplicate_deliveries_total{source}` | HTTP replay and SQS inbox duplicates. |
| `wagering_retries_total{source}` | SQS, outbox, and pending-reference retries scheduled. |
| `wagering_sqs_dlq_visible_messages` | Approximate number of currently visible messages in the DLQ. |
| `wagering_database_lock_conflicts_total` | PostgreSQL deadlocks, lock timeouts, and serialization conflicts observed by request/worker paths. |
| `wagering_reconciliation_mismatches_total` | Wallet reconciliations where the persisted balance differs from the ledger. |
| `wagering_outbox_oldest_unpublished_seconds` | Age of the oldest unpublished outbox event. |
| `wagering_transaction_processing_duration_seconds` | Processing duration histogram for HTTP, SQS, and reference retry paths. |

Counters and histograms are in-memory per process and reset when that process restarts. A Prometheus scraper should scrape every instance and aggregate series. The DLQ value is an SQS approximate visible-message count; it does not include messages currently in flight.

## Local development and tests

See [README.md](README.md) for setup, `.env.example`, Swagger login, seed, commands and diagnosis. All unit, HTTP e2e and PostgreSQL/LocalStack integration suites run on the native Bun test runner; mocks and lifecycle hooks come from `bun:test`. `bun run test:all` runs these suites in sequence.

## Shutdown and crash experiment

The bootstrap enables Nest shutdown hooks. SIGTERM invokes worker lifecycle cleanup, stops timers and waits for in-flight work. The SQS consumer acknowledges only committed operations. SIGKILL cannot execute cleanup; durable inbox and financial records must make recovery safe without relying on hooks.

The crash integration test spawns a real Bun process running `SqsWagerConsumerWorker` against a dedicated FIFO queue. A test-only SDK proxy pauses at `DeleteMessageCommand` before forwarding it, after the real worker has committed its database transaction. The parent reads the committed wallet from another connection, sends SIGKILL and waits for process termination. A new Bun process receives the message after visibility expiration, detects the committed inbox entry and acknowledges it. Assertions verify one debit, one wager, two ledger entries including opening, one completed inbox entry, unchanged outbox count and reconciliation. The proxy is confined to the fixture; production code contains no crash switches.

## Load experiment

`bun run test:load` reads local settings from `.env`, requires explicit enablement and rejects remote database/broker targets. It creates a unique schema and three FIFO queues and starts its own API. Authentication uses the real local Keycloak service account and the API's real JWKS verifier. `KEEP_TEST_SCHEMA` controls schema retention; queues and the child process are cleaned up.

The workload submits unique BET requests against one shared wallet, checks reconciliation and independent expected final balance, and records throughput, end-to-end percentiles, errors, lock conflicts and sampled outbox lag. A short closed-loop benchmark does not establish production capacity or complete downstream event delivery. Historic LOSS and pre-OIDC BET reports remain labeled as earlier experiments and must not be presented as equivalent workloads.

## Requirement evidence and limits

Native Bun suites cover Money, wallet and wager invariants, HTTP contracts, JWKS validation, real PostgreSQL/LocalStack races, three independent processes, 50 duplicate requests, immutable ledger, atomic rollback, outbox publishers, pending references, retries/DLQ and real SIGKILL recovery. Migrations are rolled down and reapplied on an isolated schema. The IdP and load integration are verified separately against the local Keycloak deployment.

These are scenario-based guarantees, not exhaustive proof over every possible interleaving. The challenge defines no target RPS. Production identity authorization, provider integration, AWS IAM/TLS, capacity planning, operational retention and deployment grace periods remain deployment concerns. The selected single-total-reversal business rule is explicit and should be confirmed with the evaluator.
