import { describe, it, expect } from 'vitest';
import { Wallet, InsufficientFundsError } from './wallet.entity';
import { Money } from '../../../../shared/domain/value-objects/money';

describe('Wallet Aggregate Root', () => {
  it('should successfully open a wallet with initial balance and version 1', () => {
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
    const wallet = Wallet.open({
      id: 'wallet-123',
      playerId: 'player-456',
      initialBalance,
    });

    expect(wallet.id).toBe('wallet-123');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('should successfully debit a valid amount and increment version', () => {
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
    const wallet = Wallet.open({
      id: 'wallet-123',
      playerId: 'player-456',
      initialBalance,
    });

    const debitAmount = Money.from({ amount: '30.00', currency: 'BRL' });
    wallet.debit(debitAmount);

    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
  });

  it('should throw InsufficientFundsError when debiting more than available balance', () => {
    const initialBalance = Money.from({ amount: '50.00', currency: 'BRL' });
    const wallet = Wallet.open({
      id: 'wallet-123',
      playerId: 'player-456',
      initialBalance,
    });

    const excessiveDebit = Money.from({ amount: '80.00', currency: 'BRL' });

    expect(() => wallet.debit(excessiveDebit)).toThrow(InsufficientFundsError);
    // Saldo e versão devem permanecer intactos após falha
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  it('should successfully credit an amount and increment version', () => {
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
    const wallet = Wallet.open({
      id: 'wallet-123',
      playerId: 'player-456',
      initialBalance,
    });

    const creditAmount = Money.from({ amount: '50.00', currency: 'BRL' });
    wallet.credit(creditAmount);

    expect(wallet.balance.toString()).toBe('150.00');
    expect(wallet.version).toBe(2);
  });

  it('should reject operations with currency mismatch', () => {
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
    const wallet = Wallet.open({
      id: 'wallet-123',
      playerId: 'player-456',
      initialBalance,
    });

    const usdAmount = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.debit(usdAmount)).toThrow();
    expect(() => wallet.credit(usdAmount)).toThrow();
  });
});
