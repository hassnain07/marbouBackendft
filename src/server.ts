import http from 'http';
import { createApp } from './app';
import { startCron } from './cron';
import { initSockets } from './sockets/chat';
import { env } from './config/env';

const app = createApp();
const httpServer = http.createServer(app);

initSockets(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`🚀 MARBOU API running on port ${env.PORT} [${env.NODE_ENV}]`);
  startCron();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  httpServer.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0));
});

export { httpServer };
export default httpServer;
