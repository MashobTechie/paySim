import { HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@paysim/shared-types';

/**
 * Base class for expected, domain-level failures. Throw subclasses of this from
 * services; the global exception filter turns them into the standard error envelope.
 * Unexpected errors (anything else) are logged with a stack and returned as INTERNAL_ERROR.
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly httpStatus: HttpStatus,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super('NOT_FOUND', message, HttpStatus.NOT_FOUND, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, HttpStatus.CONFLICT, details);
  }
}
