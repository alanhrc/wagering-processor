import { createHash } from 'crypto';

export interface WagerPayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

export function hashWagerPayload(payload: WagerPayloadHashInput): string {
  const businessPayload: WagerPayloadHashInput = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    walletId: payload.walletId,
    playerId: payload.playerId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    ...(payload.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: payload.referenceExternalTransactionId }),
  };

  return createHash('sha256').update(canonicalJson(businessPayload)).digest('hex');
}
