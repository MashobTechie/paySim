import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createLogger } from './infrastructure/logger/create-logger.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), { logger });
  app.disable('x-powered-by');
  app.enableCors({ origin: env.CORS_ORIGIN });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT);
  logger.log(`PaySim API listening on http://localhost:${env.API_PORT}`, 'Bootstrap');
}

try {
  await bootstrap();
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
  } else {
    console.error('Fatal error during bootstrap', error);
  }
  process.exit(1);
}
