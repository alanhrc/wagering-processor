import { describe, it, expect } from 'bun:test';
import {
  MissingWagerReferenceError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.entity';
import { WalletLedgerEntry, LedgerDirection } from './wallet-ledger-entry.entity';
import { Money } from '../../../../shared/domain/value-objects/money';

describe('WagerTransaction & Ledger Domain', () => {
  it('should create a valid PENDING transaction and transition to PROCESSED', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    const tx = WagerTransaction.create({
      id: 'tx-1',
      providerId: 'prov-a',
      externalTransactionId: 'ext-123',
      idempotencyKey: 'prov-a:ext-123',
      payloadHash: 'abc123hash',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money,
    });

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.affectsBalance()).toBe(false); // Só afeta quando processado

    tx.markProcessed();
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.isTerminal()).toBe(true);
  });

  it('should reject REFUND or ROLLBACK without referenceExternalTransactionId', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });

    expect(() => {
      WagerTransaction.create({
        id: 'tx-2',
        providerId: 'prov-a',
        externalTransactionId: 'ext-124',
        idempotencyKey: 'prov-a:ext-124',
        payloadHash: 'abc123hash',
        walletId: 'w-1',
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'slot-1',
        kind: WagerTransactionKind.Refund,
        money,
        // Sem referenceExternalTransactionId propositalmente
      });
    }).toThrow(MissingWagerReferenceError);

    expect(() => {
      WagerTransaction.create({
        id: 'tx-3',
        providerId: 'prov-a',
        externalTransactionId: 'ext-125',
        idempotencyKey: 'prov-a:ext-125',
        payloadHash: 'abc123hash',
        walletId: 'w-1',
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'slot-1',
        kind: WagerTransactionKind.Rollback,
        money,
      });
    }).toThrow(MissingWagerReferenceError);
  });

  it('should validate ledger balance arithmetic correctly', () => {
    const before = Money.from({ amount: '100.00', currency: 'BRL' });
    const amount = Money.from({ amount: '25.00', currency: 'BRL' });
    const after = Money.from({ amount: '75.00', currency: 'BRL' });

    const entry = WalletLedgerEntry.create({
      id: 'l-1',
      walletId: 'w-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: amount,
      balanceBefore: before,
      balanceAfter: after,
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('should fail ledger validation if arithmetic does not match', () => {
    const before = Money.from({ amount: '100.00', currency: 'BRL' });
    const amount = Money.from({ amount: '25.00', currency: 'BRL' });
    const incorrectAfter = Money.from({ amount: '50.00', currency: 'BRL' }); // Errado

    expect(() => {
      WalletLedgerEntry.create({
        id: 'l-2',
        walletId: 'w-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: amount,
        balanceBefore: before,
        balanceAfter: incorrectAfter,
      });
    }).toThrow();
  });
});
