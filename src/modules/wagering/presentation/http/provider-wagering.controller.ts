import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  GetWagerTransactionUseCase,
  WagerTransactionNotFoundError,
} from '../../application/use-cases/get-wager-transaction.use-case';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWageringController {
  constructor(private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase) {}

  @Get(':externalTransactionId')
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
