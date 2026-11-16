import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredJsonLogger } from './structured-json-logger';

describe('StructuredJsonLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes JSON with UTC time and omits financial values and payloads', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    new StructuredJsonLogger().log('wager_processed', {
      event: 'wager_processed',
      correlationId: 'correlation-1',
      walletId: 'wallet-1',
      amount: '25.00',
      payload: { money: { amount: '25.00' } },
    });

    const entry = JSON.parse(String(output.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      message: 'wager_processed',
      event: 'wager_processed',
      correlationId: 'correlation-1',
      walletId: 'wallet-1',
    });
    expect(entry.timestamp).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(entry).not.toHaveProperty('amount');
    expect(entry).not.toHaveProperty('payload');
  });
});
