import { Body, Controller, HttpCode, HttpStatus, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import type { CreateWalletCommand } from '../../application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase, WalletNotFoundError } from '../../application/use-cases/reconcile-wallet.use-case';

@Controller('wallets')
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateWalletCommand) {
    return this.createWalletUseCase.execute(body);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    try {
      const result = await this.reconcileWalletUseCase.execute(walletId);
      if (!result.consistent) {
        this.logger.error(
          JSON.stringify({
            event: 'wallet_reconciliation_mismatch',
            walletId,
            storedBalance: result.storedBalance,
            calculatedBalance: result.calculatedBalance,
            difference: result.difference,
            checkedEntries: result.checkedEntries,
          }),
        );
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
