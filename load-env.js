// load-env.js
// This file loads environment variables with proper priority:
// 1. .env.local (local development - highest priority)
// 2. .env (production/default)

const path = require('path');
const fs = require('fs');

// Check if .env.local exists
const envLocalPath = path.join(__dirname, '.env.local');
const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envLocalPath)) {
  console.log('📝 Loading environment from .env.local (local development mode)');
  require('dotenv').config({ path: envLocalPath });
} else if (fs.existsSync(envPath)) {
  console.log('📝 Loading environment from .env (production mode)');
  require('dotenv').config({ path: envPath });
} else {
  console.log('⚠️  No .env file found, using system environment variables');
}
