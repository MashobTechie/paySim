import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorCode, ApiErrorResponse } from '@paysim/shared-types';
import type { Response } from 'express';
import { AppError } from '../errors/app-error.js';
import type { RequestWithContext } from '../types/request-context.js';

const CODE_BY_STATUS: Partial<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

/** Converts every thrown error into the ApiErrorResponse envelope. Never leaks internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    // requestId is absent if the error was raised before RequestContextMiddleware ran.
    const req = ctx.getRequest<
      Partial<RequestWithContext> & Pick<RequestWithContext, 'originalUrl'>
    >();
    const res = ctx.getResponse<Response>();
    const requestId = req.requestId ?? 'unknown';

    const { status, body } = this.toResponse(exception, requestId);

    if (status >= 500) {
      this.logger.error(
        { requestId, path: req.originalUrl, error: describe(exception) },
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(status).json(body);
  }

  private toResponse(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            requestId,
            ...(exception.details === undefined ? {} : { details: exception.details }),
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
      return { status, body: { error: { code, message: exception.message, requestId } } };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } },
    };
  }
}

function describe(exception: unknown): string {
  return exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);
}
