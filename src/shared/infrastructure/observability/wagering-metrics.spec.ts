import { describe, expect, it } from 'bun:test';
import { WageringMetrics } from './wagering-metrics';
import { WagerTransactionStatus } from '../../../modules/wagering/domain/entities/wager-transaction.entity';

describe('WageringMetrics', () => {
  it('renders transaction, duplicate, retry, and duration metrics', () => {
    const metrics = new WageringMetrics();
    metrics.recordTransaction(WagerTransactionStatus.Processed);
    metrics.recordDuplicate('http_replay');
    metrics.recordRetry('sqs');
    metrics.recordProcessingDuration(25);

    const output = metrics.renderPrometheusMetrics(undefined, undefined);

    expect(output).toContain('wagering_transactions_total{status="PROCESSED"} 1');
    expect(output).toContain('wagering_duplicate_deliveries_total{source="http_replay"} 1');
    expect(output).toContain('wagering_retries_total{source="sqs"} 1');
    expect(output).toContain('wagering_transaction_processing_duration_seconds_count 1');
  });

  it('counts recognized PostgreSQL lock conflicts', () => {
    const metrics = new WageringMetrics();
    metrics.recordDatabaseError({ cause: { code: '40P01' } });

    expect(metrics.renderPrometheusMetrics(undefined, undefined)).toContain(
      'wagering_database_lock_conflicts_total 1',
    );
  });

  it('renders externally collected outbox and dead-letter queue gauges', () => {
    const metrics = new WageringMetrics();

    const output = metrics.renderPrometheusMetrics(12.5, 4);

    expect(output).toContain('wagering_outbox_oldest_unpublished_seconds 12.5');
    expect(output).toContain('wagering_sqs_dlq_visible_messages 4');
  });

  it('counts wallet reconciliation mismatches', () => {
    const metrics = new WageringMetrics();
    metrics.recordReconciliationMismatch();

    expect(metrics.renderPrometheusMetrics(undefined, undefined)).toContain(
      'wagering_reconciliation_mismatches_total 1',
    );
  });
});
