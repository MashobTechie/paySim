import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { RequestWithContext } from '../../common/types/request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Assigns every request a traceable ID (honouring a well-formed inbound x-request-id),
 * echoes it on the response, and emits one structured log line per completed request.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    const inbound = req.header(REQUEST_ID_HEADER);
    req.requestId = inbound && VALID_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, req.requestId);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const entry = {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
      };
      if (res.statusCode >= 500) this.logger.error(entry);
      else if (res.statusCode >= 400) this.logger.warn(entry);
      else this.logger.log(entry);
    });

    next();
  }
}
