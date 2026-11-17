import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { Money } from '../../../../shared/domain/value-objects/money.js';
import { Wallet } from '../../domain/entities/wallet.entity.js';
import { FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/entities/wager-transaction.entity.js';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity.js';
import type { IUnitOfWork, WageringRepositories } from '../../domain/ports/wagering.repository.interface.js';
import type { IntegrationEvent } from '../../domain/events/integration-event.js';
import { hashWagerPayload } from '../hash-wager-payload.js';
import { IdempotencyKeyConflictError, ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import type { ProcessWagerCommand } from './process-wager-transaction.use-case.js';

function scenario() {
  const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
  const transactions = new Map<string, WagerTransaction>();
  const ledger: WalletLedgerEntry[] = [];
  const events: IntegrationEvent<object>[] = [];
  const repositories: WageringRepositories = {
    wallets: {
      findById: async (id) => id === wallet.id ? wallet : null,
      findByIdWithLock: async (id) => id === wallet.id ? wallet : null,
      save: async () => {},
    },
    wagers: {
      lockIdempotencyKey: async () => {},
      findById: async (id) => [...transactions.values()].find((transaction) => transaction.id === id) ?? null,
      findByIdempotencyKey: async (key) => transactions.get(key) ?? null,
      findByExternalId: async (providerId, externalId) => [...transactions.values()].find(
        (transaction) => transaction.providerId === providerId && transaction.externalTransactionId === externalId,
      ) ?? null,
      hasSuccessfulReversal: async (providerId, externalId, excludingId) => [...transactions.values()].some(
        (transaction) => transaction.providerId === providerId && transaction.referenceExternalTransactionId === externalId &&
          transaction.id !== excludingId && transaction.status === WagerTransactionStatus.Processed &&
          [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(transaction.kind),
      ),
      findPendingReferencesDue: async () => [],
      save: async (transaction) => { transactions.set(transaction.idempotencyKey, transaction); },
    },
    ledger: {
      save: async (entry) => { ledger.push(entry); },
      findPage: async () => [],
      reconcile: async () => null,
    },
    outbox: { enqueue: async (event) => { events.push(event); } },
  };
  const uow: IUnitOfWork = { transactional: async (work) => work(repositories) };
  const useCase = new ProcessWagerTransactionUseCase(uow);
  const command = (kind: WagerTransactionKind, amount = '10.00', referenceExternalTransactionId?: string): ProcessWagerCommand => {
    const externalTransactionId = crypto.randomUUID();
    const payload = {
      providerId: 'unit-provider', externalTransactionId, playerId: wallet.playerId, walletId: wallet.id,
      roundId: 'unit-round', gameId: 'unit-game', kind, money: { amount, currency: 'BRL' },
      ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
    };
    return { ...payload, idempotencyKey: `unit:${externalTransactionId}`, payloadHash: hashWagerPayload(payload) };
  };
  return { wallet, ledger, events, transactions, useCase, command };
}

describe('ProcessWagerTransactionUseCase business rules', () => {
  it.each([
    [WagerTransactionKind.Bet, '90.00', LedgerDirection.Debit, 2],
    [WagerTransactionKind.Win, '110.00', LedgerDirection.Credit, 2],
    [WagerTransactionKind.Loss, '100.00', undefined, 1],
  ] as const)('applies %s with the expected financial effect', async (kind, balance, direction, version) => {
    const test = scenario();
    const result = await test.useCase.execute(test.command(kind));
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(test.wallet.balance.toString()).toBe(balance);
    expect(test.wallet.version).toBe(version);
    expect(test.ledger).toHaveLength(direction ? 1 : 0);
    if (direction) expect(test.ledger[0]?.direction).toBe(direction);
    expect(test.events).toHaveLength(direction ? 2 : 1);
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('reverses a BET through %s exactly once', async (kind) => {
    const test = scenario();
    const bet = test.command(WagerTransactionKind.Bet);
    await test.useCase.execute(bet);
    const reversal = test.command(kind, '10.00', bet.externalTransactionId);
    const result = await test.useCase.execute(reversal);
    const replay = await test.useCase.execute(reversal);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.idempotentReplay).toBe(true);
    expect(test.wallet.balance.toString()).toBe('100.00');
    expect(test.ledger).toHaveLength(2);
    expect(test.ledger[1]?.direction).toBe(LedgerDirection.Credit);
  });

  it('rolls back a WIN by debiting the credited amount', async () => {
    const test = scenario();
    const win = test.command(WagerTransactionKind.Win);
    await test.useCase.execute(win);
    await test.useCase.execute(test.command(WagerTransactionKind.Rollback, '10.00', win.externalTransactionId));
    expect(test.wallet.balance.toString()).toBe('100.00');
    expect(test.ledger[1]?.direction).toBe(LedgerDirection.Debit);
  });

  it('rejects a second total reversal without creating another ledger entry', async () => {
    const test = scenario();
    const bet = test.command(WagerTransactionKind.Bet);
    await test.useCase.execute(bet);
    await test.useCase.execute(test.command(WagerTransactionKind.Refund, '10.00', bet.externalTransactionId));
    const rejected = await test.useCase.execute(test.command(WagerTransactionKind.Rollback, '10.00', bet.externalTransactionId));
    expect(rejected.failureCode).toBe(FailureCode.DuplicateTransaction);
    expect(test.wallet.balance.toString()).toBe('100.00');
    expect(test.ledger).toHaveLength(2);
  });

  it('persists an insufficient-funds rejection without changing balance or ledger', async () => {
    const test = scenario();
    const result = await test.useCase.execute(test.command(WagerTransactionKind.Bet, '101.00'));
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(test.wallet.balance.toString()).toBe('100.00');
    expect(test.ledger).toHaveLength(0);
    expect(test.transactions).toHaveLength(1);
  });

  it('rejects a divergent payload under the same idempotency key', async () => {
    const test = scenario();
    const bet = test.command(WagerTransactionKind.Bet);
    await test.useCase.execute(bet);
    await rejects(async () => test.useCase.execute({ ...bet, money: { amount: '20.00', currency: 'BRL' }, payloadHash: 'different' }), IdempotencyKeyConflictError);
    expect(test.wallet.balance.toString()).toBe('90.00');
    expect(test.ledger).toHaveLength(1);
  });

  it('replays the original balance after a later operation changes the wallet', async () => {
    const test = scenario();
    const first = test.command(WagerTransactionKind.Bet);
    await test.useCase.execute(first);
    await test.useCase.execute(test.command(WagerTransactionKind.Bet));
    const replay = await test.useCase.execute(first);
    expect(replay.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(test.wallet.balance.toString()).toBe('80.00');
    expect(test.ledger).toHaveLength(2);
  });

  it('preserves the rejected response balance and wallet currency after subsequent writes', async () => {
    const test = scenario();
    const invalid = { ...test.command(WagerTransactionKind.Bet), money: { amount: '10.00', currency: 'USD' } };
    invalid.payloadHash = hashWagerPayload(invalid);
    const rejected = await test.useCase.execute(invalid);
    await test.useCase.execute(test.command(WagerTransactionKind.Bet));
    const replay = await test.useCase.execute(invalid);
    expect(rejected.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(replay.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(test.wallet.balance.toString()).toBe('90.00');
  });

  it('defers an absent reference without moving funds', async () => {
    const test = scenario();
    const result = await test.useCase.execute(test.command(WagerTransactionKind.Refund, '10.00', 'not-yet-received'));
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(test.events[0]?.eventType).toBe('WagerTransactionPendingReference');
    expect(test.wallet.balance.toString()).toBe('100.00');
    expect(test.ledger).toHaveLength(0);
  });
});
