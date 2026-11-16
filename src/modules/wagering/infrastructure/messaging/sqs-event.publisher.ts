import { Injectable } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsEventPublisher {
  private readonly queueUrl: string;

  constructor(private readonly sqsClient: SQSClient) {
    this.queueUrl =
      process.env.AWS_SQS_EVENTS_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
  }

  async publish(envelope: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: Record<string, unknown>;
  }): Promise<void> {
    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.aggregateId, // Ordena por walletId sem bloquear outras wallets
      MessageDeduplicationId: envelope.eventId,
    });

    await this.sqsClient.send(command);
  }
}
