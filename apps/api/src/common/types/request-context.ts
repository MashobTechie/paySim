import type { Request } from 'express';

/** Express request after RequestContextMiddleware has run. */
export interface RequestWithContext extends Request {
  requestId: string;
}
