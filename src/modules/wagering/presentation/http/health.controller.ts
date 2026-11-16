import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly wagerQueueUrl: string;

  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient,
  ) {
    this.wagerQueueUrl =
      process.env.AWS_SQS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.allSettled([
      this.em.getConnection().execute('SELECT 1'),
      this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.wagerQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      ),
    ]);
    const checks = {
      postgres: postgres.status === 'fulfilled' ? 'ok' : 'error',
      sqs: sqs.status === 'fulfilled' ? 'ok' : 'error',
    };

    if (postgres.status === 'rejected' || sqs.status === 'rejected') {
      this.logger.error(JSON.stringify({ event: 'readiness_check_failed', checks }));
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }
}
