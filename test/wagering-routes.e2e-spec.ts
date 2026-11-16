import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { CreateWalletUseCase } from '../src/modules/wagering/application/use-cases/create-wallet.use-case';
import { GetWalletQueriesUseCase } from '../src/modules/wagering/application/use-cases/get-wallet-queries.use-case';
import { GetWagerTransactionUseCase } from '../src/modules/wagering/application/use-cases/get-wager-transaction.use-case';
import { ProcessWagerTransactionUseCase } from '../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../src/modules/wagering/application/use-cases/reconcile-wallet.use-case';
import { HealthController } from '../src/modules/wagering/presentation/http/health.controller';
import { ProviderWageringController } from '../src/modules/wagering/presentation/http/provider-wagering.controller';
import { WageringController } from '../src/modules/wagering/presentation/http/wagering.controller';
import { WalletController } from '../src/modules/wagering/presentation/http/wallet.controller';

describe('Wagering HTTP routes (e2e)', () => {
  let app: INestApplication;

  const createWallet = { execute: vi.fn() };
  const reconcileWallet = { execute: vi.fn() };
  const getWalletQueries = { getWallet: vi.fn(), getLedger: vi.fn() };
  const processWager = { execute: vi.fn() };
  const getWagerTransaction = { byId: vi.fn(), byExternalId: vi.fn() };
  const postgresConnection = { execute: vi.fn() };
  const sqsClient = { send: vi.fn() };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletController, WageringController, ProviderWageringController, HealthController],
      providers: [
        { provide: CreateWalletUseCase, useValue: createWallet },
        { provide: ReconcileWalletUseCase, useValue: reconcileWallet },
        { provide: GetWalletQueriesUseCase, useValue: getWalletQueries },
        { provide: ProcessWagerTransactionUseCase, useValue: processWager },
        { provide: GetWagerTransactionUseCase, useValue: getWagerTransaction },
        { provide: EntityManager, useValue: { getConnection: () => postgresConnection } },
        { provide: SQSClient, useValue: sqsClient },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves GET /health/live', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('serves GET /health/ready when PostgreSQL and SQS respond', async () => {
    postgresConnection.execute.mockResolvedValueOnce([{ '?column?': 1 }]);
    sqsClient.send.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000000000000:wager-transactions.fifo' } });

    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toEqual({ status: 'ok', checks: { postgres: 'ok', sqs: 'ok' } });
  });

  it('creates a wallet through POST /wallets', async () => {
    createWallet.execute.mockResolvedValueOnce({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });

    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({ playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } })
      .expect(201);

    expect(response.body).toMatchObject({ id: 'wallet-1', balance: { amount: '100.00', currency: 'BRL' } });
  });

  it('serves GET /wallets/:walletId', async () => {
    getWalletQueries.getWallet.mockResolvedValueOnce({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: { amount: '90.00', currency: 'BRL' },
      version: 2,
    });

    const response = await request(app.getHttpServer()).get('/wallets/wallet-1').expect(200);

    expect(response.body).toMatchObject({ id: 'wallet-1', balance: { amount: '90.00', currency: 'BRL' } });
  });

  it('serves GET /wallets/:walletId/ledger with pagination query parameters', async () => {
    getWalletQueries.getLedger.mockResolvedValueOnce({ walletId: 'wallet-1', entries: [], nextCursor: null });

    const response = await request(app.getHttpServer())
      .get('/wallets/wallet-1/ledger?limit=10&cursor=cursor-value')
      .expect(200);

    expect(response.body).toEqual({ walletId: 'wallet-1', entries: [], nextCursor: null });
    expect(getWalletQueries.getLedger).toHaveBeenCalledWith('wallet-1', '10', 'cursor-value');
  });

  it('serves POST /wallets/:walletId/reconciliation', async () => {
    reconcileWallet.execute.mockResolvedValueOnce({
      walletId: 'wallet-1',
      storedBalance: { amount: '90.00', currency: 'BRL' },
      calculatedBalance: { amount: '90.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });

    const response = await request(app.getHttpServer()).post('/wallets/wallet-1/reconciliation').expect(200);

    expect(response.body).toMatchObject({ walletId: 'wallet-1', consistent: true, checkedEntries: 2 });
  });

  it('serves GET /wagering/transactions/:transactionId', async () => {
    getWagerTransaction.byId.mockResolvedValueOnce({ transactionId: 'transaction-1', status: 'PROCESSED' });

    const response = await request(app.getHttpServer())
      .get('/wagering/transactions/transaction-1')
      .expect(200);

    expect(response.body).toEqual({ transactionId: 'transaction-1', status: 'PROCESSED' });
  });

  it('serves POST /wagering/transactions and passes idempotency and correlation headers', async () => {
    processWager.execute.mockResolvedValueOnce({
      transactionId: 'transaction-1',
      status: 'PROCESSED',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const payload = {
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };

    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:external-1')
      .set('X-Correlation-Id', 'correlation-1')
      .send(payload)
      .expect(200);

    expect(response.body).toMatchObject({ transactionId: 'transaction-1', status: 'PROCESSED' });
    expect(processWager.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'provider-a:external-1',
        correlationId: 'correlation-1',
        providerId: 'provider-a',
        externalTransactionId: 'external-1',
      }),
    );
  });

  it('rejects POST /wagering/transactions without an idempotency key', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send({ providerId: 'provider-a' })
      .expect(400);

    expect(processWager.execute).not.toHaveBeenCalled();
  });

  it('serves GET /providers/:providerId/wagering/transactions/:externalTransactionId', async () => {
    getWagerTransaction.byExternalId.mockResolvedValueOnce({
      transactionId: 'transaction-1',
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      status: 'PROCESSED',
    });

    const response = await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/external-1')
      .expect(200);

    expect(response.body).toMatchObject({
      transactionId: 'transaction-1',
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
    });
  });
});
