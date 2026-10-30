import type { Env } from './env.js';

/** Injectable, read-only view of the validated environment. */
export class AppConfig {
  constructor(readonly env: Readonly<Env>) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
