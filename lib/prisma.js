// lib/prisma.js
// Single shared PrismaClient instance to prevent connection exhaustion
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = global;

const prisma = globalForPrisma.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

// Always cache in global to prevent multiple instances
globalForPrisma.prisma = prisma;

module.exports = prisma;
