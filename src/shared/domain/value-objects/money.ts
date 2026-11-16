export interface MoneyProps {
  amount: string;   // Ex: "25.00"
  currency: string; // Ex: "BRL"
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class Money {
  private constructor(
    private readonly amountInCents: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props.amount || typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Invalid amount: must be a non-empty string');
    }

    const trimmed = props.amount.trim();

    // Regex estrita: aceita números inteiros ou com 1 a 2 casas decimais (opcionalmente negativo)
    const strictDecimalRegex = /^-?\d+(\.\d{1,2})?$/;
    if (!strictDecimalRegex.test(trimmed)) {
      throw new InvalidMoneyError(`Invalid monetary string format: "${props.amount}". Must be a valid decimal with up to 2 decimal places.`);
    }

    // Quebra a string em partes (antes e depois do ponto) para evitar float math
    const [majorPart, minorPart = ''] = trimmed.split('.');
    const absoluteCents = BigInt(majorPart.replace('-', '')) * 100n + BigInt(minorPart.padEnd(2, '0'));
    const totalCents = trimmed.startsWith('-') ? -absoluteCents : absoluteCents;

    if (!props.currency || props.currency.trim().length !== 3) {
      throw new InvalidMoneyError('Invalid currency: must be a 3-letter ISO-4217 code');
    }

    return new Money(totalCents, props.currency.toUpperCase().trim());
  }

  static zero(currency: string): Money {
    return new Money(0n, currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountInCents + other.amountInCents, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountInCents - other.amountInCents, this.currency);
  }

  public negate(): Money {
    return new Money(-this.amountInCents, this.currency);
  }

  public isZero(): boolean {
    return this.amountInCents === 0n;
  }

  public isPositive(): boolean {
    return this.amountInCents > 0n;
  }

  public isNegative(): boolean {
    return this.amountInCents < 0n;
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amountInCents < other.amountInCents;
  }

  public equals(other: Money): boolean {
    return this.currency === other.currency && this.amountInCents === other.amountInCents;
  }

  public toString(): string {
    const absCents = this.amountInCents < 0n ? -this.amountInCents : this.amountInCents;
    const major = absCents / 100n;
    const minor = absCents % 100n;
    const formattedMinor = minor.toString().padStart(2, '0');
    const sign = this.amountInCents < 0n ? '-' : '';
    return `${sign}${major}.${formattedMinor}`;
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: cannot operate between ${this.currency} and ${other.currency}`);
    }
  }
}
