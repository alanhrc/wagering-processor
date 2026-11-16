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

`Money` stores exact decimal values and serializes `amount` as a fixed two-decimal string. Persistence stores integer minor units alongside the currency. JavaScript `number` is not used for monetary arithmetic. The model accepts currencies, while the challenge examples and local workflows use BRL.

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

Authentication is intentionally not implemented because the challenge assigns it no points. `ProviderIdentityGuard` is applied to business controllers and currently allows requests; it marks the code location where an OIDC/identity-provider integration can be added. Health and metrics endpoints are open. The SQS channel is treated as internal, while provider identity fields still pass domain validation.

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

See [README.md](README.md) for the step-by-step setup, `.env.example` variables, routes, and test commands. The project does not include or run a seeder; wallet creation is available through `POST /wallets`.
