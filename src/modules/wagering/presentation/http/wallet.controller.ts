import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import type { CreateWalletCommand } from '../../application/use-cases/create-wallet.use-case';

@Controller('wallets')
export class WalletController {
  constructor(private readonly createWalletUseCase: CreateWalletUseCase) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateWalletCommand) {
    return this.createWalletUseCase.execute(body);
  }
}
