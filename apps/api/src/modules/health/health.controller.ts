import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HealthResponse } from '@paysim/shared-types';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** 200 when all dependencies are up, 503 when degraded — usable as a readiness probe. */
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const result = await this.health.check();
    res.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
