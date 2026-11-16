import { Controller, Post, Body, Headers, HttpCode, HttpStatus, HttpException, Get, Param, NotFoundException } from '@nestjs/common';
import {
  IdempotencyKeyConflictError,
  InternalWagerTransactionError,
  InvalidWagerTransactionKindError,
  ProcessWagerTransactionUseCase,
  ProcessWagerCommand,
} from '../../application/use-cases/process-wager-transaction.use-case';
import { InsufficientFundsError } from '../../domain/entities/wallet.entity';
import { InvalidWagerAmountError } from '../../domain/entities/wager-transaction.entity';
import { hashWagerPayload } from '../../application/hash-wager-payload';
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
} from '@nestjs/swagger';

@ApiTags('Wagering')
@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
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
    description: 'Transaction result. A repeated request returns the original result with idempotentReplay set to true.',
    schema: {
      example: {
        transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        idempotentReplay: false,
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Required idempotency header or transaction input is invalid.' })
  @ApiResponse({ status: 409, description: 'The idempotency key was already used with a different payload.' })
  @ApiResponse({ status: 422, description: 'The transaction violates a business rule, such as insufficient funds.' })
  @ApiResponse({ status: 500, description: 'Unexpected processing failure.' })
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: Omit<ProcessWagerCommand, 'idempotencyKey' | 'payloadHash' | 'correlationId'>,
  ) {
    if (!idempotencyKey) {
      throw new HttpException('Missing required header: Idempotency-Key', HttpStatus.BAD_REQUEST);
    }

    const payloadHash = hashWagerPayload(body);

    const command: ProcessWagerCommand = {
      ...body,
      idempotencyKey,
      payloadHash,
      ...(correlationId ? { correlationId } : {}),
    };

    try {
      const result = await this.processWagerUseCase.execute(command);
      return result;
    } catch (error: any) {
      if (error instanceof IdempotencyKeyConflictError) {
        throw new HttpException({ error: error.message }, HttpStatus.CONFLICT); // 409
      }
      if (error instanceof InsufficientFundsError) {
        throw new HttpException({ error: error.message }, HttpStatus.UNPROCESSABLE_ENTITY); // 422
      }
      if (
        error instanceof InternalWagerTransactionError ||
        error instanceof InvalidWagerAmountError ||
        error instanceof InvalidWagerTransactionKindError
      ) {
        throw new HttpException({ error: error.message }, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException({ error: error.message || 'Internal server error' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
