const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.$queryRawUnsafe('SELECT 1')
  .then(r => console.log('Prisma client connected:', JSON.stringify(r)))
  .catch(e => console.log('Prisma client error:', e.message))
  .finally(() => p.$disconnect());
