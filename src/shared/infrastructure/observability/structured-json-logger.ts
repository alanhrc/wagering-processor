import { LoggerService } from '@nestjs/common';

type LogLevel = 'info' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

const sensitiveKeyPattern = /amount|balance|money|payload|body|password|secret|authorization|token/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error);
}

function sanitize(value: unknown): unknown {
  if (value instanceof Error) return { errorType: value.name };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, nested]) =>
        sensitiveKeyPattern.test(key) ? [] : [[key, sanitize(nested)]],
      ),
    );
  }
  return value;
}

export class StructuredJsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const fields = optionalParams.find(isRecord);
    const context = [...optionalParams].reverse().find((value): value is string => typeof value === 'string');
    const safeMessage = typeof message === 'string'
      ? message
      : message instanceof Error
        ? message.name
        : 'application_event';
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      message: safeMessage,
      ...(fields ? sanitize(fields) as Record<string, unknown> : {}),
    };
    const stream = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(entry)}\n`);
  }
}
