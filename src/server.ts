import { createApp } from './app';
import { startCron } from './cron';
import { env } from './config/env';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`🚀 MARBOU API running on port ${env.PORT} [${env.NODE_ENV}]`);
  startCron();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

export default server;
