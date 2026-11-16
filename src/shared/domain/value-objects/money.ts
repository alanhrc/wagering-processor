export interface MoneyProps {
  amount: string;   // Ex: "25.00"
  currency: string; // Ex: "BRL"
}

export class Money {
  private constructor(
    private readonly amountInCents: number,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props.amount || typeof props.amount !== 'string') {
      throw new Error('Invalid amount: must be a non-empty string');
    }

    const trimmed = props.amount.trim();

    // Regex estrita: aceita números inteiros ou com 1 a 2 casas decimais (opcionalmente negativo)
    const strictDecimalRegex = /^-?\d+(\.\d{1,2})?$/;
    if (!strictDecimalRegex.test(trimmed)) {
      throw new Error(`Invalid monetary string format: "${props.amount}". Must be a valid decimal with up to 2 decimal places.`);
    }

    // Quebra a string em partes (antes e depois do ponto) para evitar float math
    const parts = trimmed.split('.');
    const majorUnits = parseInt(parts[0], 10);
    let minorUnits = 0;

    if (parts[1]) {
      // Padroniza para garantir 2 dígitos (ex: "5" vira "50" centavos)
      const paddedMinor = parts[1].padEnd(2, '0').slice(0, 2);
      minorUnits = parseInt(paddedMinor, 10);
    }

    // Calcula o total em centavos respeitando o sinal
    let totalCents = Math.abs(majorUnits) * 100 + minorUnits;
    if (majorUnits < 0 || trimmed.startsWith('-')) {
      totalCents = -totalCents;
    }

    // Segurança contra estouro de inteiro seguro do JS (Number.MAX_SAFE_INTEGER)
    if (!Number.isSafeInteger(totalCents)) {
      throw new Error('Amount exceeds safe integer limits');
    }

    if (!props.currency || props.currency.trim().length !== 3) {
      throw new Error('Invalid currency: must be a 3-letter ISO-4217 code');
    }

    return new Money(totalCents, props.currency.toUpperCase().trim());
  }

  static zero(currency: string): Money {
    return new Money(0, currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountInCents + other.amountInCents, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountInCents - other.amountInCents, this.currency);
  }

  public isZero(): boolean {
    return this.amountInCents === 0;
  }

  public isPositive(): boolean {
    return this.amountInCents > 0;
  }

  public isNegative(): boolean {
    return this.amountInCents < 0;
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amountInCents < other.amountInCents;
  }

  public equals(other: Money): boolean {
    return this.currency === other.currency && this.amountInCents === other.amountInCents;
  }

  public toString(): string {
    const absCents = Math.abs(this.amountInCents);
    const major = Math.floor(absCents / 100);
    const minor = absCents % 100;
    const formattedMinor = minor.toString().padStart(2, '0');
    const sign = this.amountInCents < 0 ? '-' : '';
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
