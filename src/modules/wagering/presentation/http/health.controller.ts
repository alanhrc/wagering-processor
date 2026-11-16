import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../../shared/infrastructure/auth/access-token.guard.js';

@ApiTags('Health')
@Public()
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
  @ApiOperation({ summary: 'Check whether the application process is alive' })
  @ApiResponse({ status: 200, description: 'The process is running.', schema: { example: { status: 'ok' } } })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check whether PostgreSQL and SQS are reachable' })
  @ApiResponse({
    status: 200,
    description: 'The application can serve requests.',
    schema: { example: { status: 'ok', checks: { postgres: 'ok', sqs: 'ok' } } },
  })
  @ApiResponse({
    status: 503,
    description: 'At least one dependency is unavailable.',
    schema: { example: { status: 'error', checks: { postgres: 'ok', sqs: 'error' } } },
  })
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
      this.logger.error('readiness_check_failed', { event: 'readiness_check_failed', checks });
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }
}
