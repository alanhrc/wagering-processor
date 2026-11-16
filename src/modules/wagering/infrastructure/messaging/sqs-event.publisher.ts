import { Injectable } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { IntegrationEventEnvelope } from '../../domain/events/integration-event';

@Injectable()
export class SqsEventPublisher {
  private readonly queueUrl: string;

  constructor(private readonly sqsClient: SQSClient) {
    this.queueUrl =
      process.env.AWS_SQS_EVENTS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-events.fifo';
  }

  async publish(envelope: IntegrationEventEnvelope<Record<string, unknown>>): Promise<void> {
    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.aggregateId, // Ordena por walletId sem bloquear outras wallets
      MessageDeduplicationId: envelope.eventId,
    });

    await this.sqsClient.send(command);
  }
}
