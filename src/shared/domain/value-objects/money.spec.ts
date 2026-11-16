import { describe, it, expect } from 'bun:test';
import { Money } from './money';

describe('Money Value Object (Cents-based)', () => {
  it('should correctly parse strings into minor units (cents)', () => {
    const m = Money.from({ amount: '25.50', currency: 'BRL' });
    expect(m.toString()).toBe('25.50');
    expect(m.currency).toBe('BRL');
  });

  it('should handle single digit decimal places correctly (e.g., "10.5" -> "10.50")', () => {
    const m = Money.from({ amount: '10.5', currency: 'BRL' });
    expect(m.toString()).toBe('10.50');
  });

  it('should reject invalid decimal formats (more than 2 decimal places)', () => {
    expect(() => Money.from({ amount: '25.505', currency: 'BRL' })).toThrow();
  });

  it('should reject invalid strings like letters or empty', () => {
    expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow();
  });

  it('should perform precise addition and subtraction without float errors', () => {
    const m1 = Money.from({ amount: '0.10', currency: 'BRL' });
    const m2 = Money.from({ amount: '0.20', currency: 'BRL' });
    const sum = m1.add(m2);

    // O clássico problema do JS (0.1 + 0.2 = 0.30000000000000004) não existe aqui!
    expect(sum.toString()).toBe('0.30');
  });

  it('should throw error on currency mismatch', () => {
    const m1 = Money.from({ amount: '10.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => m1.add(m2)).toThrow();
  });
});
