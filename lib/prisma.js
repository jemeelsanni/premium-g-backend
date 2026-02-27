// lib/prisma.js
// Single shared PrismaClient instance with connection pooling and auto-reconnect
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = global;

if (!globalForPrisma.prisma) {
  // Build DATABASE_URL with connection pool limits
  const dbUrl = process.env.DATABASE_URL || '';
  const separator = dbUrl.includes('?') ? '&' : '?';
  const pooledUrl = dbUrl.includes('connection_limit')
    ? dbUrl
    : `${dbUrl}${separator}connection_limit=5&pool_timeout=30`;

  globalForPrisma.prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: {
      db: { url: pooledUrl }
    }
  });
}

const prisma = globalForPrisma.prisma;

module.exports = prisma;
