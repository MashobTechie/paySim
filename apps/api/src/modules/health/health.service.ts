import { Injectable } from '@nestjs/common';
import type { HealthCheckResult, HealthResponse } from '@paysim/shared-types';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

const DB_CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthResponse> {
    const database = await this.checkDatabase();
    return {
      status: database.status === 'up' ? 'ok' : 'degraded',
      service: 'paysim-api',
      version: process.env.npm_package_version ?? '0.0.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { database },
    };
  }

  private async checkDatabase(): Promise<HealthCheckResult> {
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('timed out'));
          }, DB_CHECK_TIMEOUT_MS);
        }),
      ]);
      return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      return { status: 'down', error: error instanceof Error ? error.message : 'unknown error' };
    } finally {
      clearTimeout(timer);
    }
  }
}
