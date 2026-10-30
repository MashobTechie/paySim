import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export class EnvValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Loads the monorepo root .env (if present) without overriding variables that are
 * already set, then validates. Throws EnvValidationError with every problem listed.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env) loadRootEnvFile();

  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Walks up from cwd to the workspace root (marked by pnpm-workspace.yaml) and loads its .env. */
function loadRootEnvFile(): void {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const file = path.join(dir, '.env');
      if (existsSync(file)) process.loadEnvFile(file);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
