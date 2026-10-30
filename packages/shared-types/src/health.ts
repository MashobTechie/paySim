export type HealthStatus = 'ok' | 'degraded';

export type DependencyStatus = 'up' | 'down';

export interface HealthCheckResult {
  status: DependencyStatus;
  latencyMs?: number;
  error?: string;
}

export interface HealthResponse {
  status: HealthStatus;
  service: 'paysim-api';
  version: string;
  timestamp: string;
  uptimeSeconds: number;
  checks: {
    database: HealthCheckResult;
  };
}
