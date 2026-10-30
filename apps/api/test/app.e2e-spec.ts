import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ApiErrorResponse, HealthResponse } from '@paysim/shared-types';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { loadEnv } from '../src/config/env.js';

describe('API foundation (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      // Points at the docker-compose database if running; the suite passes either way.
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://paysim:x@localhost:5433/paysim',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env)],
    }).compile();
    app = moduleRef.createNestApplication({ logger: ['error'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports service status and database check', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    const body = res.body as HealthResponse;

    expect([200, 503]).toContain(res.status);
    expect(body.service).toBe('paysim-api');
    expect(body.status).toBe(res.status === 200 ? 'ok' : 'degraded');
    expect(['up', 'down']).toContain(body.checks.database.status);
  });

  it('assigns a request ID and honours a well-formed inbound one', async () => {
    const generated = await request(app.getHttpServer()).get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'trace-123');
    expect(echoed.headers['x-request-id']).toBe('trace-123');
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .set('x-request-id', 'r-1');
    const body = res.body as ApiErrorResponse;

    expect(res.status).toBe(404);
    expect(body.error).toMatchObject({ code: 'NOT_FOUND', requestId: 'r-1' });
  });
});
