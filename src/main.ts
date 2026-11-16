import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureSwagger } from './swagger';
import { StructuredJsonLogger } from './shared/infrastructure/observability/structured-json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredJsonLogger(),
  });
  app.enableShutdownHooks();
  configureSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
