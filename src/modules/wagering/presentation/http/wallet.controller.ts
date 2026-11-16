import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import type { CreateWalletCommand } from '../../application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase, WalletNotFoundError } from '../../application/use-cases/reconcile-wallet.use-case';
import {
  GetWalletQueriesUseCase,
  InvalidLedgerQueryError,
} from '../../application/use-cases/get-wallet-queries.use-case';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Wallets')
@Controller('wallets')
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    private readonly getWalletQueriesUseCase: GetWalletQueriesUseCase,
  ) {}

  @Get(':walletId')
  @ApiOperation({ summary: 'Get a wallet and its current balance' })
  @ApiParam({ name: 'walletId', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  @ApiResponse({
    status: 200,
    description: 'Wallet found.',
    schema: {
      example: {
        id: '0192f291-27dd-7d3f-8071-5f8685deef37',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        balance: { amount: '975.00', currency: 'BRL' },
        version: 2,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Wallet does not exist.' })
  async getWallet(@Param('walletId') walletId: string) {
    try {
      return await this.getWalletQueriesUseCase.getWallet(walletId);
    } catch (error: unknown) {
      if (error instanceof WalletNotFoundError) throw new NotFoundException(error.message);
      throw error;
    }
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Get a cursor-paginated wallet ledger' })
  @ApiParam({ name: 'walletId', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size from 1 to 100; defaults to 50.', example: '50' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque cursor returned by the previous page.', example: 'eyJjcmVhdGVkQXQiOiIyMDI2LTExLTE2IDE3OjAwOjAwLjEyMzQ1NitVVEMiLCJpZCI6ImxlZGdlci0xIn0' })
  @ApiResponse({
    status: 200,
    description: 'Entries are ordered by creation time and ID in descending order.',
    schema: {
      example: {
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        entries: [
          {
            id: '0192f29a-27dd-7d3f-8071-5f8685deef37',
            transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
            direction: 'DEBIT',
            money: { amount: '25.00', currency: 'BRL' },
            balanceBefore: { amount: '1000.00', currency: 'BRL' },
            balanceAfter: { amount: '975.00', currency: 'BRL' },
            createdAt: '2026-11-16T17:00:00.123Z',
          },
        ],
        nextCursor: 'eyJjcmVhdGVkQXQiOiIyMDI2LTExLTE2IDE3OjAwOjAwLjEyMzQ1NitVVEMiLCJpZCI6ImxlZGdlci0xIn0',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'The limit or cursor is invalid.' })
  @ApiResponse({ status: 404, description: 'Wallet does not exist.' })
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.getWalletQueriesUseCase.getLedger(walletId, limit, cursor);
    } catch (error: unknown) {
      if (error instanceof WalletNotFoundError) throw new NotFoundException(error.message);
      if (error instanceof InvalidLedgerQueryError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a wallet and its opening ledger entry' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['playerId', 'initialBalance'],
      properties: {
        playerId: { type: 'string', format: 'uuid', example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' },
        initialBalance: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'string', example: '1000.00' },
            currency: { type: 'string', example: 'BRL' },
          },
        },
      },
      example: {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Wallet created. A positive opening balance also creates an OPENING transaction and ledger entry.',
    schema: {
      example: {
        id: '0192f291-27dd-7d3f-8071-5f8685deef37',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        balance: { amount: '1000.00', currency: 'BRL' },
        version: 1,
      },
    },
  })
  create(@Body() body: CreateWalletCommand) {
    return this.createWalletUseCase.execute(body);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compare the wallet balance with its ledger balance' })
  @ApiParam({ name: 'walletId', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  @ApiResponse({
    status: 200,
    description: 'A mismatch is reported and does not modify the wallet.',
    schema: {
      example: {
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        storedBalance: { amount: '975.00', currency: 'BRL' },
        calculatedBalance: { amount: '975.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 42,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Wallet does not exist.' })
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
