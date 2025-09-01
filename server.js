const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
require('dotenv').config();

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const distributionRoutes = require('./routes/distribution');
const transportRoutes = require('./routes/transport');
const warehouseRoutes = require('./routes/warehouse');
const adminRoutes = require('./routes/admin');

// Import middleware - FIXED: destructure errorHandler
const { authenticateToken, authorizeRole } = require('./middleware/auth');
const { auditLogger } = require('./middleware/auditLogger');
const { errorHandler } = require('./middleware/errorHandler'); // ✅ FIXED: destructure

const app = express();
const PORT = process.env.PORT || 3001;

// ================================
// MIDDLEWARE SETUP
// ================================

// Security middleware
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// Audit logging middleware (for authenticated routes)
app.use('/api/', auditLogger);

// ================================
// ROUTES
// ================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API routes
const apiVersion = process.env.API_VERSION || 'v1';
app.use(`/api/${apiVersion}/auth`, authRoutes);
app.use(`/api/${apiVersion}/users`, authenticateToken, userRoutes);
app.use(`/api/${apiVersion}/distribution`, authenticateToken, distributionRoutes);
app.use(`/api/${apiVersion}/transport`, authenticateToken, transportRoutes);
app.use(`/api/${apiVersion}/warehouse`, authenticateToken, warehouseRoutes);
app.use(`/api/${apiVersion}/admin`, authenticateToken, authorizeRole(['SUPER_ADMIN']), adminRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware - Now properly destructured
app.use(errorHandler);

// ================================
// SERVER STARTUP
// ================================

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Premium G Enterprise System Server
📡 Server running on port ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
📋 API Version: ${apiVersion}
⏰ Started at: ${new Date().toISOString()}
  `);
});

module.exports = app;