import 'server-only';
import type { HealthResponse } from '@paysim/shared-types';

const API_URL = process.env.PAYSIM_API_URL ?? 'http://localhost:4000';

export type HealthResult =
  { reachable: true; health: HealthResponse } | { reachable: false; error: string };

/** Server-side health probe. Never throws — an unreachable API is a displayable state. */
export async function getApiHealth(): Promise<HealthResult> {
  try {
    const res = await fetch(`${API_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    // 503 still carries a valid HealthResponse body (degraded).
    return { reachable: true, health: (await res.json()) as HealthResponse };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export { API_URL };
