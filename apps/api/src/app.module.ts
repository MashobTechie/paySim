import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { RequestContextMiddleware } from './infrastructure/logger/request-context.middleware.js';
import { QueuesModule } from './infrastructure/queues/queues.module.js';
import { ClaimsModule } from './modules/claims/claims.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { FailureInjectionModule } from './modules/failure-injection/failure-injection.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ReplayModule } from './modules/replay/replay.module.js';
import { StateMachineModule } from './modules/state-machine/state-machine.module.js';
import { TestRunsModule } from './modules/test-runs/test-runs.module.js';

@Module({})
export class AppModule implements NestModule {
  /** Takes the validated env explicitly so tests can boot the app with their own config. */
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        DatabaseModule,
        QueuesModule,
        HealthModule,
        PaymentsModule,
        ClaimsModule,
        EventsModule,
        StateMachineModule,
        FailureInjectionModule,
        ReplayModule,
        TestRunsModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
