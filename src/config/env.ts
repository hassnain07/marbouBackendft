import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

// Strict boolean: only "true" or "1" are truthy; everything else (including empty) is false
const strictBool = z.string().optional().transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),

  JWT_USER_SECRET: z.string().min(1),
  JWT_ADMIN_SECRET: z.string().min(1),
  OTP_PEPPER: z.string().min(1),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  PUBLIC_WEB_URL: z.string().default('http://localhost:3000'),

  RUN_CRON: strictBool,
  TRUST_PROXY: z.string().optional(),

  RATE_LIMIT_STRICT_PER_MIN: z.coerce.number().default(20),
  RATE_LIMIT_NORMAL_PER_MIN: z.coerce.number().default(300),

  PUBLIC_API_URL: z.string().default('http://localhost:4000'),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  STORAGE_PUBLIC_URL: z.string().default('http://localhost:4000/files'),

  FFPROBE_PATH: z.string().optional(),

  EMAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  SMTP_URL: z.string().optional(),

  SMS_DRIVER: z.enum(['mock', 'http']).default('mock'),
  WHATSAPP_DRIVER: z.enum(['mock', 'http']).default('mock'),

  AUTH_MOCK: strictBool,
  GOOGLE_CLIENT_IDS: z.string().optional(),
  FACEBOOK_APP_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),

  DEV_TOTP_FIXED_CODE: z.string().optional(),
  DEV_HELPERS: strictBool,

  SEED_ADMIN_EMAIL: z.string().default('admin@marbou.test'),
  SEED_ADMIN_PASSWORD: z.string().default('Admin#12345'),
  SEED_DEMO_ADMINS: z.string().optional(),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  PUSH_DRIVER: z.enum(['console', 'fcm']).default('console'),
  FCM_SERVICE_ACCOUNT: z.string().optional(),

  ANALYTICS_SALT: z.string().default('analytics-salt'),
  ADMIN_TOTP_ENC_KEY: z.string().min(1),

  SENTRY_DSN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Placeholder values from .env.example that must not be used in production
const EXAMPLE_PLACEHOLDERS = [
  'change-me-to-a-random-32-plus-char-secret-here',
  'change-me-admin-to-a-random-32-plus-char-secret',
  'change-me-otp-pepper-32-plus-chars-here',
  'change-me-analytics-salt-32-plus-chars-here',
  'change-me-totp-enc-key-32-plus-chars-here',
];

// Production guards
if (env.NODE_ENV === 'production') {
  const errors: string[] = [];
  if (env.JWT_USER_SECRET.length < 32) errors.push('JWT_USER_SECRET must be 32+ chars');
  if (env.JWT_ADMIN_SECRET.length < 32) errors.push('JWT_ADMIN_SECRET must be 32+ chars');
  if (env.OTP_PEPPER.length < 32) errors.push('OTP_PEPPER must be 32+ chars');
  if (env.AUTH_MOCK) errors.push('AUTH_MOCK must not be set in production');
  if (env.DEV_HELPERS) errors.push('DEV_HELPERS must not be set in production');
  if (env.DEV_TOTP_FIXED_CODE) errors.push('DEV_TOTP_FIXED_CODE must not be set in production');
  if (!env.ADMIN_TOTP_ENC_KEY || env.ADMIN_TOTP_ENC_KEY.length < 32) errors.push('ADMIN_TOTP_ENC_KEY must be 32+ chars in production');
  if (EXAMPLE_PLACEHOLDERS.includes(env.ADMIN_TOTP_ENC_KEY)) errors.push('ADMIN_TOTP_ENC_KEY must not be the .env.example placeholder');
  if (!env.ANALYTICS_SALT || env.ANALYTICS_SALT.length < 32) errors.push('ANALYTICS_SALT must be 32+ chars in production');
  if (EXAMPLE_PLACEHOLDERS.includes(env.ANALYTICS_SALT)) errors.push('ANALYTICS_SALT must not be the .env.example placeholder');
  if (errors.length) {
    console.error('❌ Production startup refused:', errors);
    process.exit(1);
  }
}

export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
export const isProd = env.NODE_ENV === 'production';
export const runCron = env.RUN_CRON && !isTest;
export const devHelpers = env.DEV_HELPERS && !isProd;
export const authMock = env.AUTH_MOCK && !isProd;
