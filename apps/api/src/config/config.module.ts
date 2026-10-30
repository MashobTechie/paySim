import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig } from './app-config.js';
import type { Env } from './env.js';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: AppConfig, useValue: new AppConfig(env) }],
      exports: [AppConfig],
    };
  }
}
