import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

export const strictLimiter = rateLimit({
  windowMs: 60_000,
  max: env.RATE_LIMIT_STRICT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
  skip: () => env.NODE_ENV === 'test',
});

export const normalLimiter = rateLimit({
  windowMs: 60_000,
  max: env.RATE_LIMIT_NORMAL_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
  skip: () => env.NODE_ENV === 'test',
});

export const limiters = {
  strict: strictLimiter,
  normal: normalLimiter,
};
