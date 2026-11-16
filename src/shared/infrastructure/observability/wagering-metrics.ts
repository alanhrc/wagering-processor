import { Injectable } from '@nestjs/common';
import { WagerTransactionStatus } from '../../../modules/wagering/domain/entities/wager-transaction.entity';

export type WageringMetricSource = 'http_replay' | 'sqs_inbox';
export type WageringRetrySource = 'sqs' | 'outbox' | 'pending_reference';

const transactionStatuses = Object.values(WagerTransactionStatus);
const retrySources: WageringRetrySource[] = ['sqs', 'outbox', 'pending_reference'];
const duplicateSources: WageringMetricSource[] = ['http_replay', 'sqs_inbox'];
const durationBucketsSeconds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function getPostgresErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as Record<string, unknown>;
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause ?? candidate.driverException;
  }
  return undefined;
}

@Injectable()
export class WageringMetrics {
  private readonly transactionCounts = new Map<WagerTransactionStatus, number>(
    transactionStatuses.map((status) => [status, 0]),
  );
  private readonly duplicateCounts = new Map<WageringMetricSource, number>(
    duplicateSources.map((source) => [source, 0]),
  );
  private readonly retryCounts = new Map<WageringRetrySource, number>(
    retrySources.map((source) => [source, 0]),
  );
  private readonly collectionErrorCounts = new Map<string, number>([
    ['postgres', 0],
    ['sqs', 0],
  ]);
  private readonly processingDurationCounts = Array.from({ length: durationBucketsSeconds.length }, () => 0);
  private processingDurationCount = 0;
  private processingDurationSum = 0;
  private lockConflictCount = 0;
  private reconciliationMismatchCount = 0;

  recordTransaction(status: WagerTransactionStatus): void {
    this.transactionCounts.set(status, (this.transactionCounts.get(status) ?? 0) + 1);
  }

  recordDuplicate(source: WageringMetricSource): void {
    this.duplicateCounts.set(source, (this.duplicateCounts.get(source) ?? 0) + 1);
  }

  recordRetry(source: WageringRetrySource): void {
    this.retryCounts.set(source, (this.retryCounts.get(source) ?? 0) + 1);
  }

  recordDatabaseError(error: unknown): void {
    const code = getPostgresErrorCode(error);
    if (code === '40P01' || code === '55P03' || code === '40001') {
      this.lockConflictCount += 1;
    }
  }

  recordProcessingDuration(milliseconds: number): void {
    const seconds = Math.max(milliseconds, 0) / 1_000;
    this.processingDurationCount += 1;
    this.processingDurationSum += seconds;
    durationBucketsSeconds.forEach((bucket, index) => {
      if (seconds <= bucket) this.processingDurationCounts[index] += 1;
    });
  }

  recordMetricsCollectionError(dependency: 'postgres' | 'sqs'): void {
    this.collectionErrorCounts.set(
      dependency,
      (this.collectionErrorCounts.get(dependency) ?? 0) + 1,
    );
  }

  recordReconciliationMismatch(): void {
    this.reconciliationMismatchCount += 1;
  }

  renderPrometheusMetrics(outboxLagSeconds: number | undefined, dlqVisibleMessages: number | undefined): string {
    const lines = [
      '# HELP wagering_transactions_total Wager transaction processing results by status.',
      '# TYPE wagering_transactions_total counter',
      ...transactionStatuses.map(
        (status) => `wagering_transactions_total{status="${status}"} ${this.transactionCounts.get(status) ?? 0}`,
      ),
      '# HELP wagering_duplicate_deliveries_total Duplicate wager deliveries detected by source.',
      '# TYPE wagering_duplicate_deliveries_total counter',
      ...duplicateSources.map(
        (source) => `wagering_duplicate_deliveries_total{source="${source}"} ${this.duplicateCounts.get(source) ?? 0}`,
      ),
      '# HELP wagering_retries_total Scheduled retries by processing component.',
      '# TYPE wagering_retries_total counter',
      ...retrySources.map(
        (source) => `wagering_retries_total{source="${source}"} ${this.retryCounts.get(source) ?? 0}`,
      ),
      '# HELP wagering_database_lock_conflicts_total PostgreSQL deadlocks, lock timeouts, and serialization conflicts.',
      '# TYPE wagering_database_lock_conflicts_total counter',
      `wagering_database_lock_conflicts_total ${this.lockConflictCount}`,
      '# HELP wagering_reconciliation_mismatches_total Wallet reconciliations where stored and ledger balances differ.',
      '# TYPE wagering_reconciliation_mismatches_total counter',
      `wagering_reconciliation_mismatches_total ${this.reconciliationMismatchCount}`,
      '# HELP wagering_transaction_processing_duration_seconds Wager transaction processing duration.',
      '# TYPE wagering_transaction_processing_duration_seconds histogram',
      ...durationBucketsSeconds.map(
        (bucket, index) => `wagering_transaction_processing_duration_seconds_bucket{le="${bucket}"} ${this.processingDurationCounts[index]}`,
      ),
      `wagering_transaction_processing_duration_seconds_bucket{le="+Inf"} ${this.processingDurationCount}`,
      `wagering_transaction_processing_duration_seconds_sum ${this.processingDurationSum}`,
      `wagering_transaction_processing_duration_seconds_count ${this.processingDurationCount}`,
      '# HELP wagering_metrics_collection_errors_total Errors while collecting external gauges.',
      '# TYPE wagering_metrics_collection_errors_total counter',
      ...['postgres', 'sqs'].map(
        (dependency) => `wagering_metrics_collection_errors_total{dependency="${dependency}"} ${this.collectionErrorCounts.get(dependency) ?? 0}`,
      ),
    ];

    if (outboxLagSeconds !== undefined) {
      lines.push(
        '# HELP wagering_outbox_oldest_unpublished_seconds Age of the oldest unpublished outbox event.',
        '# TYPE wagering_outbox_oldest_unpublished_seconds gauge',
        `wagering_outbox_oldest_unpublished_seconds ${outboxLagSeconds}`,
      );
    }
    if (dlqVisibleMessages !== undefined) {
      lines.push(
        '# HELP wagering_sqs_dlq_visible_messages Approximate visible message count in the wager dead-letter queue.',
        '# TYPE wagering_sqs_dlq_visible_messages gauge',
        `wagering_sqs_dlq_visible_messages ${dlqVisibleMessages}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }
}
