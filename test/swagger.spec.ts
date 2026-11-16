import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import request from 'supertest';
import { configureSwagger } from '../src/swagger';
import { WalletController } from '../src/modules/wagering/presentation/http/wallet.controller';
import { WageringController } from '../src/modules/wagering/presentation/http/wagering.controller';
import { ProviderWageringController } from '../src/modules/wagering/presentation/http/provider-wagering.controller';
import { HealthController } from '../src/modules/wagering/presentation/http/health.controller';
import { CreateWalletUseCase } from '../src/modules/wagering/application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../src/modules/wagering/application/use-cases/reconcile-wallet.use-case';
import { GetWalletQueriesUseCase } from '../src/modules/wagering/application/use-cases/get-wallet-queries.use-case';
import { ProcessWagerTransactionUseCase } from '../src/modules/wagering/application/use-cases/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../src/modules/wagering/application/use-cases/get-wager-transaction.use-case';

describe('OpenAPI documentation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletController, WageringController, ProviderWageringController, HealthController],
      providers: [
        { provide: CreateWalletUseCase, useValue: {} },
        { provide: ReconcileWalletUseCase, useValue: {} },
        { provide: GetWalletQueriesUseCase, useValue: {} },
        { provide: ProcessWagerTransactionUseCase, useValue: {} },
        { provide: GetWagerTransactionUseCase, useValue: {} },
        { provide: EntityManager, useValue: {} },
        { provide: SQSClient, useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication();
    configureSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves all HTTP routes with examples and request headers', async () => {
    await request(app.getHttpServer()).get('/docs').expect(200).expect('content-type', /html/);
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);
    const paths = response.body.paths as Record<string, Record<string, unknown>>;

    expect(Object.keys(paths).sort()).toEqual([
      '/health/live',
      '/health/ready',
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
      '/wagering/transactions',
      '/wagering/transactions/{transactionId}',
      '/wallets',
      '/wallets/{walletId}',
      '/wallets/{walletId}/ledger',
      '/wallets/{walletId}/reconciliation',
    ]);

    const submitOperation = paths['/wagering/transactions']?.post as {
      parameters: Array<{ name: string; in: string; required?: boolean }>;
      requestBody: { content: { 'application/json': { schema: { example: { kind: string; money: { amount: string } } } } } };
      responses: Record<string, unknown>;
    };
    expect(submitOperation.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
    expect(submitOperation.requestBody.content['application/json'].schema.example).toMatchObject({
      kind: 'BET',
      money: { amount: '25.00' },
    });
    expect(submitOperation.responses).toHaveProperty('409');

    const reconciliationOperation = paths['/wallets/{walletId}/reconciliation']?.post as {
      responses: Record<string, { content?: { 'application/json'?: { schema?: { example?: unknown } } } }>;
    };
    expect(
      reconciliationOperation.responses['200']?.content?.['application/json']?.schema?.example,
    ).toMatchObject({ consistent: true, difference: { amount: '0.00', currency: 'BRL' } });
  });
});
