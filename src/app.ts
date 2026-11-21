import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import { env } from './config/env';
import { errorMiddleware } from './shared/errors';
import { normalLimiter } from './shared/rateLimit';
import { settings } from './shared/settings';
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { adminRouter } from './modules/admin/routes';
import { catalogRouter } from './modules/catalog/routes';
import { storage } from './shared/storage';
import { db } from './shared/db';
import path from 'path';
import fs from 'fs';

const EXEMPT_PATHS = ['/health', '/api/v1/health', '/api/v1/config', '/api/v1/translations', '/docs', '/openapi.json'];
const ADMIN_PATHS = ['/api/v1/admin'];

export function createApp() {
  const app = express();

  // ─── Logging ────────────────────────────────────────────────────────────────
  app.use(pinoHttp({
    genReqId: () => randomUUID(),
    customProps: (req) => ({ traceId: req.id }),
  }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { traceId: string }).traceId = (req as Request & { id?: string }).id ?? randomUUID();
    next();
  });

  // ─── Security ───────────────────────────────────────────────────────────────
  app.use(helmet());

  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));

  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  // ─── Language ───────────────────────────────────────────────────────────────
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers['accept-language'] ?? 'ar';
    (req as Request & { lang: string }).lang = header.startsWith('en') ? 'en' : 'ar';
    next();
  });

  // ─── Maintenance ────────────────────────────────────────────────────────────
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const isExempt =
      EXEMPT_PATHS.some((p) => req.path.startsWith(p)) ||
      ADMIN_PATHS.some((p) => req.path.startsWith(p)) ||
      req.path.startsWith('/dev');
    if (isExempt) return next();
    try {
      const maintenance = await settings.get<{ enabled: boolean; messageAr?: string; messageEn?: string }>(
        'app.maintenance', { enabled: false },
      );
      if (maintenance.enabled) {
        const lang = (req as Request & { lang?: string }).lang ?? 'ar';
        const message = lang === 'en' ? maintenance.messageEn : maintenance.messageAr;
        return res.status(503).json({ error: { code: 'MAINTENANCE', message: message ?? 'Under maintenance' } });
      }
    } catch { /* ignore */ }
    next();
  });

  // ─── Min version ────────────────────────────────────────────────────────────
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const appVersion = req.headers['x-app-version'] as string | undefined;
    const platform = req.headers['x-platform'] as string | undefined;
    if (!appVersion || !platform) return next();

    const isExempt =
      EXEMPT_PATHS.some((p) => req.path.startsWith(p)) ||
      ADMIN_PATHS.some((p) => req.path.startsWith(p)) ||
      req.path.startsWith('/dev');
    if (isExempt) return next();

    try {
      const minVersion = await settings.get<Record<string, string>>('app.minVersion', {});
      const min = minVersion[platform.toLowerCase()];
      if (min && compareVersions(appVersion, min) < 0) {
        return res.status(426).json({ error: { code: 'APP_UPDATE_REQUIRED', message: 'Please update the app' } });
      }
    } catch { /* ignore */ }
    next();
  });

  // ─── Rate limiting ──────────────────────────────────────────────────────────
  app.use('/api/v1', normalLimiter);

  // ─── Static files (local storage public) ────────────────────────────────────
  const storagePath = path.resolve(env.STORAGE_LOCAL_PATH, 'public');
  if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });
  app.use('/files', express.static(storagePath));

  // ─── Private media endpoint ──────────────────────────────────────────────────
  app.get('/media/private/:token', async (req: Request, res: Response) => {
    const result = storage.verifyToken(req.params.token);
    if (!result) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid or expired link' } });

    const asset = await db.mediaAsset.findUnique({ where: { id: result.mediaId } });
    if (!asset) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });

    const buf = storage.readFile(asset.key, true);
    if (!buf) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });

    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  });

  // ─── API routes ─────────────────────────────────────────────────────────────
  app.use('/api/v1', catalogRouter);
  app.use('/api/v1', authRouter);
  app.use('/api/v1', usersRouter);
  app.use('/api/v1', adminRouter);

  // ─── OpenAPI / Swagger ──────────────────────────────────────────────────────
  app.get('/openapi.json', (_req, res) => {
    try {
      const spec = require('../openapi.json');
      res.json(spec);
    } catch {
      res.status(404).json({ error: 'openapi.json not generated yet. Run: npm run openapi' });
    }
  });

  app.use('/docs', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html><html><head><title>MARBOU API</title>
      <meta charset="utf-8"/>
      <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
    </head><body>
      <div id="swagger-ui"></div>
      <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
      <script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset]})</script>
    </body></html>`);
  });

  // ─── Dev helpers ────────────────────────────────────────────────────────────
  if (env.DEV_HELPERS && env.NODE_ENV !== 'production') {
    const devRouter = express.Router();
    devRouter.get('/last-otp', (req: Request, res: Response) => {
      const { getLastOtp } = require('./shared/email');
      const email = req.query.email as string;
      const purpose = (req.query.purpose as string) ?? 'REGISTER';
      const code = getLastOtp(email, purpose);
      if (!code) return res.status(404).json({ error: 'No OTP found' });
      res.json({ code });
    });
    app.use('/dev', devRouter);
  }

  // ─── 404 ────────────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // ─── Error handler ──────────────────────────────────────────────────────────
  app.use(errorMiddleware);

  return app;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
