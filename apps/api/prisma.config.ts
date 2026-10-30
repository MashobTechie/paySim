import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Single source of env for the monorepo: the root .env file.
const rootEnv = path.resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: '../../prisma/schema.prisma',
  migrations: {
    path: '../../prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
