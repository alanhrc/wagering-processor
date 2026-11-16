import { randomUUID } from 'crypto';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import { EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  attempts: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId) {
      throw new Error('Pending reference event requires a reference transaction ID');
    }

    return new WagerTransactionPendingReference({
      eventId: randomUUID(),
      aggregateId: transaction.walletId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        attempts: transaction.attempts,
      },
    });
  }
}
