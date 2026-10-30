import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// Single source of env for the monorepo: the root .env file (never overrides set vars).
const rootEnv = path.resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
