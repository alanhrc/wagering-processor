import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { WageringMetrics } from '../../../../shared/infrastructure/observability/wagering-metrics';
import { qualifiedTableName } from '../../infrastructure/persistence/qualified-table-name';
import { Public } from '../../../../shared/infrastructure/auth/access-token.guard.js';

@Controller()
@Public()
export class MetricsController {
  private readonly dlqQueueUrl: string;

  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient,
    private readonly metrics: WageringMetrics,
  ) {
    const wagerQueueUrl =
      process.env.AWS_SQS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
    this.dlqQueueUrl =
      process.env.AWS_SQS_DLQ_QUEUE_URL ||
      wagerQueueUrl.replace('wager-transactions.fifo', 'wager-transactions-dlq.fifo');
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiExcludeEndpoint()
  async scrape(): Promise<string> {
    const [outboxLagResult, dlqResult] = await Promise.allSettled([
      this.getOutboxLagSeconds(),
      this.getDlqVisibleMessageCount(),
    ]);

    const outboxLagSeconds = outboxLagResult.status === 'fulfilled' ? outboxLagResult.value : undefined;
    const dlqVisibleMessages = dlqResult.status === 'fulfilled' ? dlqResult.value : undefined;
    if (outboxLagResult.status === 'rejected') this.metrics.recordMetricsCollectionError('postgres');
    if (dlqResult.status === 'rejected') this.metrics.recordMetricsCollectionError('sqs');

    return this.metrics.renderPrometheusMetrics(outboxLagSeconds, dlqVisibleMessages);
  }

  private async getOutboxLagSeconds(): Promise<number> {
    const tableName = qualifiedTableName(this.em, 'outbox_messages');
    const [row] = await this.em.getConnection().execute<Array<{ age_seconds: number | string | null }>>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))) AS age_seconds
       FROM ${tableName}
       WHERE published_at IS NULL`,
    );
    return Number(row?.age_seconds ?? 0);
  }

  private async getDlqVisibleMessageCount(): Promise<number> {
    const response = await this.sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlqQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return Number(response.Attributes?.ApproximateNumberOfMessages ?? 0);
  }
}
