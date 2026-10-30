import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { Env, LogLevelName } from '../../config/env.js';

const SEVERITY: LogLevelName[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/**
 * Structured logger built on Nest's ConsoleLogger.
 * JSON output in production (or when LOG_FORMAT=json); human-readable otherwise.
 */
export function createLogger(env: Env): ConsoleLogger {
  const json = (env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty')) === 'json';
  const logLevels: LogLevel[] = SEVERITY.slice(0, SEVERITY.indexOf(env.LOG_LEVEL) + 1);
  return new ConsoleLogger({ json, logLevels, colors: !json, prefix: 'PaySim' });
}
