import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { getMessage } from './messages';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
    this.name = 'AppError';
  }
}

export const E = {
  badRequest: (code = 'BAD_REQUEST', details?: unknown) => new AppError(400, code, details),
  unauthorized: (code = 'UNAUTHORIZED') => new AppError(401, code),
  forbidden: (code = 'FORBIDDEN') => new AppError(403, code),
  notFound: (code = 'NOT_FOUND') => new AppError(404, code),
  conflict: (code = 'CONFLICT', details?: unknown) => new AppError(409, code, details),
  rule: (code: string, details?: unknown) => new AppError(422, code, details),
  tooMany: (code = 'RATE_LIMITED', details?: unknown) => new AppError(429, code, details),
  internal: (code = 'INTERNAL_ERROR') => new AppError(500, code),
};

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const lang = (req as { lang?: 'ar' | 'en' }).lang ?? 'ar';
  const traceId = (req as { traceId?: string }).traceId ?? '';

  if (err instanceof AppError) {
    const message = getMessage(err.code, lang) ?? err.code;
    res.status(err.status).json({
      error: { code: err.code, message, details: err.details ?? undefined, traceId },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: getMessage('VALIDATION_ERROR', lang) ?? 'Validation error',
        details: err.flatten().fieldErrors,
        traceId,
      },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({
        error: { code: 'CONFLICT', message: getMessage('CONFLICT', lang) ?? 'Conflict', traceId },
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: getMessage('NOT_FOUND', lang) ?? 'Not found', traceId },
      });
      return;
    }
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: getMessage('INTERNAL_ERROR', lang) ?? 'Internal server error',
      traceId,
    },
  });
}
