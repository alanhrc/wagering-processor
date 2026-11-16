import { Controller, Post, Body, Headers, HttpCode, HttpStatus, HttpException, Get, Param, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import {
  IdempotencyKeyConflictError,
  InternalWagerTransactionError,
  InvalidWagerTransactionKindError,
  ProcessWagerTransactionUseCase,
  ProcessWagerCommand,
  ProcessWagerResult,
  WagerWalletNotFoundError,
} from '../../application/use-cases/process-wager-transaction.use-case';
import {
  MissingWagerReferenceError,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction.entity';
import { InsufficientFundsError } from '../../domain/entities/wallet.entity';
import { InvalidWagerAmountError } from '../../domain/entities/wager-transaction.entity';
import { hashWagerPayload } from '../../application/hash-wager-payload';
import { InvalidMoneyError } from '../../../../shared/domain/value-objects/money';
import { WageringMetrics } from '../../../../shared/infrastructure/observability/wagering-metrics';
import {
  GetWagerTransactionUseCase,
  WagerTransactionNotFoundError,
} from '../../application/use-cases/get-wager-transaction.use-case';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';

type WagerRequestBody = Omit<ProcessWagerCommand, 'idempotencyKey' | 'payloadHash' | 'correlationId'>;

function isWagerTransactionKind(value: unknown): value is WagerTransactionKind {
  return Object.values(WagerTransactionKind).some((kind) => kind === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isWagerRequestBody(value: unknown): value is WagerRequestBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const body = value as Record<string, unknown>;
  const stringFields = [
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
  ];
  if (stringFields.some((field) => typeof body[field] !== 'string' || !body[field].trim())) return false;
  if (!isWagerTransactionKind(body.kind)) return false;
  if (body.referenceExternalTransactionId !== undefined && !isNonEmptyString(body.referenceExternalTransactionId)) {
    return false;
  }

  const money = body.money;
  const hasMoney = (
    money !== null &&
    typeof money === 'object' &&
    !Array.isArray(money) &&
    typeof (money as Record<string, unknown>).amount === 'string' &&
    typeof (money as Record<string, unknown>).currency === 'string'
  );
  if (!hasMoney) return false;
  if (
    (body.kind === WagerTransactionKind.Refund || body.kind === WagerTransactionKind.Rollback) &&
    (typeof body.referenceExternalTransactionId !== 'string' || !body.referenceExternalTransactionId.trim())
  ) {
    return false;
  }
  return true;
}

@ApiTags('Wagering')
@ApiBearerAuth()
@Controller('wagering')
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
    private readonly metrics: WageringMetrics,
  ) {}

  @Get('transactions/:transactionId')
  @ApiOperation({ summary: 'Get a wager transaction by its internal ID' })
  @ApiParam({ name: 'transactionId', example: '0192f298-345e-7e38-af88-e43f851a819d' })
  @ApiResponse({
    status: 200,
    description: 'Transaction found.',
    schema: {
      example: {
        transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        status: 'PROCESSED',
        createdAt: '2026-11-16T17:00:00.123Z',
        processedAt: '2026-11-16T17:00:00.456Z',
        resultBalance: { amount: '975.00', currency: 'BRL' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Transaction does not exist.' })
  async getTransaction(@Param('transactionId') transactionId: string) {
    try {
      return await this.getWagerTransactionUseCase.byId(transactionId);
    } catch (error: unknown) {
      if (error instanceof WagerTransactionNotFoundError) throw new NotFoundException(error.message);
      throw error;
    }
  }

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit a wager transaction' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Stable key for this provider operation. Reusing it with a different payload returns 409.',
    example: 'provider-a:transaction-123',
  })
  @ApiHeader({ name: 'X-Correlation-Id', required: false, example: 'request-0192f298' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'],
      properties: {
        providerId: { type: 'string', example: 'provider-a' },
        externalTransactionId: { type: 'string', example: 'transaction-123' },
        playerId: { type: 'string', format: 'uuid', example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' },
        walletId: { type: 'string', format: 'uuid', example: '0192f291-27dd-7d3f-8071-5f8685deef37' },
        roundId: { type: 'string', example: 'round-987' },
        gameId: { type: 'string', example: 'fortune-chimp' },
        kind: { type: 'string', enum: ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'], example: 'BET' },
        money: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'string', example: '25.00' },
            currency: { type: 'string', example: 'BRL' },
          },
        },
        referenceExternalTransactionId: { type: 'string', example: 'bet-transaction-123' },
      },
      example: {
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Transaction processed. A repeated request returns the original result with idempotentReplay set to true.',
    schema: {
      example: {
        transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        idempotentReplay: false,
      },
    },
  })
  @ApiResponse({
    status: 202,
    description: 'Transaction accepted and waiting for its referenced transaction.',
    schema: {
      example: {
        transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
        status: 'PENDING_REFERENCE',
        balance: { amount: '1000.00', currency: 'BRL' },
        idempotentReplay: false,
        failureCode: 'REFERENCE_NOT_FOUND',
      },
    },
  })
  @ApiResponse({
    status: 422,
    description: 'The transaction was rejected by a domain rule.',
    schema: {
      example: {
        transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
        status: 'REJECTED',
        balance: { amount: '10.00', currency: 'BRL' },
        idempotentReplay: false,
        failureCode: 'INSUFFICIENT_FUNDS',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Required idempotency header or transaction input is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was already used with a different payload.' })
  @ApiResponse({ status: 404, description: 'The wallet does not exist.' })
  @ApiResponse({ status: 500, description: 'Unexpected processing failure.' })
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) {
      throw new HttpException(
        { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Missing required header: Idempotency-Key' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!isWagerRequestBody(body)) {
      throw new HttpException(
        { code: 'INVALID_PAYLOAD', message: 'Invalid wager transaction payload' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const payloadHash = hashWagerPayload(body);

    const command: ProcessWagerCommand = {
      ...body,
      idempotencyKey,
      payloadHash,
      ...(correlationId ? { correlationId } : {}),
    };

    let result: ProcessWagerResult;
    const startedAt = performance.now();
    try {
      result = await this.processWagerUseCase.execute(command);
    } catch (error: unknown) {
      this.metrics.recordDatabaseError(error);
      this.logger.error('wager_transaction_failed', {
        event: 'wager_transaction_failed',
        correlationId: correlationId ?? idempotencyKey,
        walletId: body.walletId,
        providerId: body.providerId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      if (error instanceof IdempotencyKeyConflictError) {
        throw new HttpException(
          { code: 'IDEMPOTENCY_KEY_CONFLICT', message: error.message },
          HttpStatus.CONFLICT,
        );
      }
      if (error instanceof UniqueConstraintViolationException) {
        throw new HttpException(
          { code: 'DUPLICATE_TRANSACTION', message: 'The provider transaction already exists.' },
          HttpStatus.CONFLICT,
        );
      }
      if (error instanceof WagerWalletNotFoundError) {
        throw new HttpException(
          { code: 'WALLET_NOT_FOUND', message: error.message },
          HttpStatus.NOT_FOUND,
        );
      }
      if (error instanceof InsufficientFundsError) {
        throw new HttpException({ error: error.message }, HttpStatus.UNPROCESSABLE_ENTITY); // 422
      }
      if (
        error instanceof InternalWagerTransactionError ||
        error instanceof InvalidWagerAmountError ||
        error instanceof InvalidWagerTransactionKindError ||
        error instanceof InvalidMoneyError ||
        error instanceof MissingWagerReferenceError
      ) {
        throw new HttpException(
          { code: 'INVALID_PAYLOAD', message: error.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new InternalServerErrorException('Transaction processing failed');
    } finally {
      this.metrics.recordProcessingDuration(performance.now() - startedAt);
    }

    this.metrics.recordTransaction(result.status);
    if (result.idempotentReplay) this.metrics.recordDuplicate('http_replay');
    this.logger.log('wager_transaction_result', {
      event: 'wager_transaction_result',
      correlationId: correlationId ?? idempotencyKey,
      transactionId: result.transactionId,
      walletId: body.walletId,
      providerId: body.providerId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    });

    if (result.status === 'PENDING' || result.status === 'PENDING_REFERENCE') {
      throw new HttpException(result, HttpStatus.ACCEPTED);
    }
    if (result.status === 'REJECTED') {
      throw new HttpException(result, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (result.status === 'FAILED') {
      throw new InternalServerErrorException(result);
    }

    return result;
  }
}
