// lib/prisma.js
// Resilient PrismaClient with auto-reconnect via Proxy
const { PrismaClient } = require('@prisma/client');

function buildUrl() {
  const dbUrl = process.env.DATABASE_URL || '';
  const separator = dbUrl.includes('?') ? '&' : '?';
  if (dbUrl.includes('connection_limit')) return dbUrl;
  return `${dbUrl}${separator}connection_limit=5&pool_timeout=30&connect_timeout=10`;
}

function createClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: { db: { url: buildUrl() } }
  });
}

// Use a wrapper object so we can swap the underlying client on reconnect
const wrapper = {
  _client: null,
  _reconnecting: false,

  getClient() {
    if (!this._client) {
      this._client = createClient();
    }
    return this._client;
  },

  async reconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    try {
      console.log('🔄 Creating fresh PrismaClient...');
      // Disconnect old client silently
      if (this._client) {
        try { await this._client.$disconnect(); } catch (e) { /* ignore */ }
      }
      // Create brand new client
      this._client = createClient();
      await this._client.$connect();
      console.log('✅ Fresh PrismaClient connected');
    } catch (err) {
      console.error('❌ Reconnect failed:', err.message);
    } finally {
      this._reconnecting = false;
    }
  }
};

// Create a Proxy that forwards all property access to the current client
// This means all files using `const prisma = require('../lib/prisma')`
// will automatically get the fresh client after reconnection
const prisma = new Proxy({}, {
  get(target, prop) {
    const client = wrapper.getClient();

    // Expose reconnect method
    if (prop === '$reconnect') return () => wrapper.reconnect();

    const value = client[prop];
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  }
});

module.exports = prisma;
