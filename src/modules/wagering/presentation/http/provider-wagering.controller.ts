import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  GetWagerTransactionUseCase,
  WagerTransactionNotFoundError,
} from '../../application/use-cases/get-wager-transaction.use-case';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Providers')
@Controller('providers/:providerId/wagering/transactions')
export class ProviderWageringController {
  constructor(private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase) {}

  @Get(':externalTransactionId')
  @ApiOperation({ summary: 'Get a wager transaction by provider and external transaction ID' })
  @ApiParam({ name: 'providerId', example: 'provider-a' })
  @ApiParam({ name: 'externalTransactionId', example: 'transaction-123' })
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
  @ApiResponse({ status: 404, description: 'Transaction does not exist for this provider.' })
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      return await this.getWagerTransactionUseCase.byExternalId(providerId, externalTransactionId);
    } catch (error: unknown) {
      if (error instanceof WagerTransactionNotFoundError) throw new NotFoundException(error.message);
      throw error;
    }
  }
}
