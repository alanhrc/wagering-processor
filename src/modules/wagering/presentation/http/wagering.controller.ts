import { Controller, Post, Body, Headers, HttpCode, HttpStatus, HttpException } from '@nestjs/common';
import { ProcessWagerTransactionUseCase, ProcessWagerCommand } from '../../application/use-cases/process-wager-transaction.use-case';
import { InsufficientFundsError } from '../../domain/entities/wallet.entity';
import { createHash } from 'crypto';

@Controller('wagering')
export class WageringController {
  constructor(private readonly processWagerUseCase: ProcessWagerTransactionUseCase) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: Omit<ProcessWagerCommand, 'idempotencyKey' | 'payloadHash'>,
  ) {
    if (!idempotencyKey) {
      throw new HttpException('Missing required header: Idempotency-Key', HttpStatus.BAD_REQUEST);
    }

    // Calcula o hash canônico do payload de negócio para detecção de conflitos de payload com a mesma chave
    const payloadString = JSON.stringify({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      walletId: body.walletId,
      playerId: body.playerId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
    });
    const payloadHash = createHash('sha256').update(payloadString).digest('hex');

    const command: ProcessWagerCommand = {
      ...body,
      idempotencyKey,
      payloadHash,
    };

    try {
      const result = await this.processWagerUseCase.execute(command);
      return result;
    } catch (error: any) {
      if (error.message.includes('Idempotency key conflict')) {
        throw new HttpException({ error: error.message }, HttpStatus.CONFLICT); // 409
      }
      if (error instanceof InsufficientFundsError) {
        throw new HttpException({ error: error.message }, HttpStatus.UNPROCESSABLE_ENTITY); // 422
      }
      throw new HttpException({ error: error.message || 'Internal server error' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
