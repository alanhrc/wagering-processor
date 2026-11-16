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

@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Get('transactions/:transactionId')
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
