// server.js - Updated for completely separate modules

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const { PrismaClient, Prisma } = require('@prisma/client');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const { authenticateToken } = require('./middleware/auth');
const { auditLogger } = require('./middleware/auditLogger');

const { manageBatchStatus } = require('./jobs/batch-status-manager');
const { startInventorySyncCron } = require('./cron/inventorySyncCron');
const { reconcileCustomerBalances } = require('./cron/customerBalanceReconciliation');


// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');

// STANDALONE MODULE ROUTES
const distributionRoutes = require('./routes/distribution');
const transportRoutes = require('./routes/transport');
const warehouseRoutes = require('./routes/warehouse');
const warehouseDailyOpeningStockRoutes = require('./routes/warehouse-daily-opening-stock');
const supplierCompanyRoutes = require('./routes/supplierCompany');
const supplierProductRoutes = require('./routes/supplier-products');
const supplierTargetRoutes = require('./routes/supplier-targets');
const supplierIncentiveRoutes = require('./routes/supplier-incentives');

// SUPPORTING ROUTES
const targetRoutes = require('./routes/targets'); // Distribution targets only
const truckRoutes = require('./routes/trucks'); // Transport trucks only
const adminRoutes = require('./routes/admin');

// SEPARATE ANALYTICS ROUTES
const distributionAnalyticsRoutes = require('./routes/analytics/distribution');
const transportAnalyticsRoutes = require('./routes/analytics/transport');
const warehouseAnalyticsRoutes = require('./routes/analytics/warehouse');

// AUDIT LOG ROUTES
const auditLogRoutes = require('./routes/audit-logs');


const app = express();
const prisma = require('./lib/prisma');

// ================================
// MIDDLEWARE CONFIGURATION
// ================================

// Trust proxy - REQUIRED for Railway/Heroku/AWS deployments
app.set('trust proxy', 1);

// Security
app.use(helmet());


// CORS Configuration - supports multiple origins
const defaultOrigins = [
  'https://premiumgbrands.com',
  'https://premiumgg.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000'
];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : defaultOrigins;

console.log('🌐 CORS allowed origins:', allowedOrigins);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked origin:', origin);
      console.log('✅ Allowed origins:', allowedOrigins);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use((req, res, next) => {
  const originalJson = res.json;
  
  res.json = function(data) {
    // Convert any Prisma Decimals in the response
    const convertedData = convertPrismaDecimals(data);
    return originalJson.call(this, convertedData);
  };
  
  next();
});

// Helper function to recursively convert Prisma Decimals
// Helper function to recursively convert Prisma Decimals
function convertPrismaDecimals(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  // Check if it's a Prisma Decimal
  if (obj instanceof Prisma.Decimal) {
    return parseFloat(obj.toString());
  }
  
  // ✅ ADD THIS: Preserve Date objects
  if (obj instanceof Date) {
    return obj;
  }
  
  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => convertPrismaDecimals(item));
  }
  
  // Handle objects
  if (typeof obj === 'object') {
    const converted = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        converted[key] = convertPrismaDecimals(obj[key]);
      }
    }
    return converted;
  }
  
  return obj;
}

// Rate limiting - more restrictive for production
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging - Only log errors and slow requests to reduce log volume
if (process.env.NODE_ENV !== 'test') {
  // Only log requests that result in errors (4xx or 5xx status codes)
  app.use(morgan('combined', {
    skip: function (req, res) { return res.statusCode < 400 }
  }));
}

// ================================
// AUDIT LOGGING MIDDLEWARE
// ================================
// Apply audit logging to all authenticated API routes
app.use('/api/', auditLogger);

// ================================
// API VERSION AND HEALTH CHECK
// ================================

const apiVersion = 'v1';

// Health check endpoint with standalone module stats
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      modules: {
        distribution: 'active',
        transport: 'active', 
        warehouse: 'active'
      }
    });
  } catch (error) {
    // Destroy old client and create fresh one
    try {
      await prisma.$reconnect();
      res.json({
        status: 'healthy',
        recovered: true,
        timestamp: new Date().toISOString()
      });
    } catch (reconnectErr) {
      res.status(503).json({
        status: 'unhealthy',
        error: reconnectErr.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

// System status endpoint (requires authentication)
app.get('/api/system/status', authenticateToken, async (req, res) => {
  try {
    // Get standalone metrics for each module
    const [
      distributionOrders,
      transportOrders, 
      warehouseSales,
      recentAuditLogs
    ] = await Promise.all([
      // Distribution metrics
      prisma.distributionOrder.count({
        where: {
          createdAt: {
            gte: new Date(new Date().getTime() - 30 * 24 * 60 * 60 * 1000)
          }
        }
      }),
      
      // Transport metrics  
      prisma.transportOrder.count({
        where: {
          deliveryStatus: { in: ['SCHEDULED', 'IN_TRANSIT'] }
        }
      }),
      
      // Warehouse metrics
      prisma.warehouseSale.count({
        where: {
          createdAt: {
            gte: new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000)
          }
        }
      }),
      
      // Recent audit logs
      prisma.auditLog.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { username: true } }
        }
      })
    ]);

    // Calculate separate revenue for each module
    const distributionRevenue = await prisma.distributionOrder.aggregate({
      where: {
        status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
        createdAt: {
          gte: new Date(new Date().getTime() - 30 * 24 * 60 * 60 * 1000)
        }
      },
      _sum: { finalAmount: true }
    });

    const transportRevenue = await prisma.transportOrder.aggregate({
      where: {
        deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
        createdAt: {
          gte: new Date(new Date().getTime() - 30 * 24 * 60 * 60 * 1000)
        }
      },
      _sum: { totalOrderAmount: true }
    });

    const warehouseRevenue = await prisma.warehouseSale.aggregate({
      where: {
        createdAt: {
          gte: new Date(new Date().getTime() - 30 * 24 * 60 * 60 * 1000)
        }
      },
      _sum: { totalAmount: true }
    });

    // Get recent orders from each module
    const [recentDistributionOrders, recentTransportOrders, recentWarehouseSales] = await Promise.all([
      prisma.distributionOrder.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { name: true } },
          location: { select: { name: true } }
        }
      }),
      
      prisma.transportOrder.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          clientName: true,
          deliveryStatus: true,
          totalOrderAmount: true,
          createdAt: true
        }
      }),
      
      prisma.warehouseSale.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { name: true } }
        }
      })
    ]);

    const totalRevenue = 
      parseFloat(distributionRevenue._sum.finalAmount || 0) +
      parseFloat(transportRevenue._sum.totalOrderAmount || 0) +
      parseFloat(warehouseRevenue._sum.totalAmount || 0);

    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      data: {
        // Standalone module metrics
        modules: {
          distribution: {
            totalOrders: distributionOrders,
            revenue: parseFloat(distributionRevenue._sum.finalAmount || 0),
            recentOrders: recentDistributionOrders.map(order => ({
              id: order.id,
              customer: order.customer?.name,
              location: order.location?.name,
              amount: parseFloat(order.finalAmount),
              status: order.status,
              createdAt: order.createdAt
            }))
          },
          transport: {
            activeTrips: transportOrders,
            revenue: parseFloat(transportRevenue._sum.totalOrderAmount || 0),
            recentOrders: recentTransportOrders.map(order => ({
              id: order.id,
              orderNumber: order.orderNumber,
              client: order.clientName,
              amount: parseFloat(order.totalOrderAmount),
              status: order.deliveryStatus,
              createdAt: order.createdAt
            }))
          },
          warehouse: {
            recentSales: warehouseSales,
            revenue: parseFloat(warehouseRevenue._sum.totalAmount || 0),
            sales: recentWarehouseSales.map(sale => ({
              id: sale.id,
              product: sale.product?.name,
              quantity: sale.quantity,
              amount: parseFloat(sale.totalAmount),
              customer: sale.customerName,
              createdAt: sale.createdAt
            }))
          }
        },
        
        // Combined summary
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        recentAuditLogs: recentAuditLogs.map(log => ({
          id: log.id,
          action: log.action,
          entity: log.entity,
          user: log.user?.username,
          createdAt: log.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('System status error:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// NOTE: All cron jobs are started inside startServer() AFTER Prisma connects


// ================================
// ROUTES - STANDALONE MODULES
// ================================

// Authentication (public)
app.use(`/api/${apiVersion}/auth`, authRoutes);

// User management (authenticated)
app.use(`/api/${apiVersion}/users`, authenticateToken, userRoutes);

// STANDALONE MODULE ROUTES (completely separate)
app.use(`/api/${apiVersion}/distribution`, authenticateToken, distributionRoutes);
app.use(`/api/${apiVersion}/transport`, authenticateToken, transportRoutes);
app.use(`/api/${apiVersion}/warehouse`, authenticateToken, warehouseRoutes);
app.use(`/api/${apiVersion}/warehouse/daily-opening-stock`, authenticateToken, warehouseDailyOpeningStockRoutes);

app.use(`/api/${apiVersion}/transport`, authenticateToken, truckRoutes);

// MODULE-SPECIFIC SUPPORTING ROUTES
app.use(`/api/${apiVersion}/targets`, authenticateToken, targetRoutes); // Distribution only
app.use(`/api/${apiVersion}/trucks`, authenticateToken, truckRoutes); // Transport only
app.use(`/api/${apiVersion}/supplier-companies`, authenticateToken, supplierCompanyRoutes); // Distribution suppliers
app.use(`/api/${apiVersion}/supplier-products`, authenticateToken, supplierProductRoutes); // Supplier product catalog
app.use(`/api/${apiVersion}/supplier-targets`, authenticateToken, supplierTargetRoutes); // Supplier targets
app.use(`/api/${apiVersion}/supplier-incentives`, authenticateToken, supplierIncentiveRoutes); // Supplier incentives/profitability

// SEPARATE ANALYTICS ENDPOINTS
app.use(`/api/${apiVersion}/analytics/distribution`, authenticateToken, distributionAnalyticsRoutes);
app.use(`/api/${apiVersion}/analytics/transport`, authenticateToken, transportAnalyticsRoutes);
app.use(`/api/${apiVersion}/analytics/warehouse`, authenticateToken, warehouseAnalyticsRoutes);

// Admin routes (Super Admin only)
app.use(`/api/${apiVersion}/admin`, authenticateToken, adminRoutes);

// Audit log routes (Super Admin, Warehouse Admin)
app.use(`/api/${apiVersion}/audit-logs`, authenticateToken, auditLogRoutes);

// ================================
// API DOCUMENTATION
// ================================

app.get(`/api/${apiVersion}/docs`, (req, res) => {
  res.json({
    title: 'Premium G Enterprise Management System API - Standalone Modules',
    version: '2.0.0',
    description: 'Completely separated enterprise management system with independent distribution, transport, and warehouse arms',
    architecture: 'Standalone modules with no cross-dependencies',
    
    modules: {
      distribution: {
        description: 'Handles sales orders, customer management, and monthly targets',
        baseUrl: `/api/${apiVersion}/distribution`,
        analytics: `/api/${apiVersion}/analytics/distribution`,
        targets: `/api/${apiVersion}/targets`,
        endpoints: {
          'GET /orders': 'List distribution orders',
          'POST /orders': 'Create distribution order',
          'GET /orders/:id': 'Get specific order',
          'PUT /orders/:id': 'Update order',
          'GET /products': 'Get distribution products',
          'GET /customers': 'Get customers',
          'GET /customers': 'List distribution customers',
          'POST /customers': 'Create distribution customer',
          'GET /customers/:id': 'Get specific customer',
          'PUT /customers/:id': 'Update customer',
          'GET /customers/:id/orders': 'Get customer order history',
          'GET /locations': 'Get delivery locations'
        }
      },
      
      transport: {
        description: 'Handles transport contracts, truck management, and logistics',
        baseUrl: `/api/${apiVersion}/transport`,
        analytics: `/api/${apiVersion}/analytics/transport`,
        trucks: `/api/${apiVersion}/trucks`,
        endpoints: {
          'GET /orders': 'List transport orders (contracts)',
          'POST /orders': 'Create transport contract',
          'GET /orders/:id': 'Get specific transport order',
          'PUT /orders/:id': 'Update transport order',
          'POST /expenses': 'Record transport expenses',
          'GET /expenses': 'List transport expenses'
        }
      },
      
      warehouse: {
        description: 'Handles inventory, sales, and cash flow',
        baseUrl: `/api/${apiVersion}/warehouse`,
        analytics: `/api/${apiVersion}/analytics/warehouse`,
        endpoints: {
          'GET /inventory': 'List warehouse inventory',
          'PUT /inventory/:id': 'Update inventory levels',
          'GET /sales': 'List warehouse sales',
          'POST /sales': 'Record warehouse sale',
          'GET /cash-flow': 'Get cash flow entries',
          'POST /cash-flow': 'Create cash flow entry',
          'GET /customers': 'List warehouse customers',
          'POST /customers': 'Create warehouse customer',
          'GET /customers/:id': 'Get specific customer',
          'PUT /customers/:id': 'Update customer',
          'GET /customers/:id/purchases': 'Get customer purchase history',
          'POST /discounts/request': 'Request customer discount approval',
          'GET /discounts/requests': 'List discount approval requests (Admin)',
          'PUT /discounts/requests/:id/review': 'Approve/reject discount (Super Admin)',
          'GET /customers/:id/discounts': 'Get customer active discounts',
          'POST /discounts/check': 'Check discount eligibility for sale',
          'GET /expenses': 'List warehouse expenses',
          'POST /expenses': 'Create warehouse expense',
          'GET /expenses/:id': 'Get specific warehouse expense',
          'PUT /expenses/:id': 'Update warehouse expense',
          'DELETE /expenses/:id': 'Delete warehouse expense',
          'POST /expenses/bulk-approve': 'Bulk approve expenses (Admin)',
          'GET /expenses/analytics/summary': 'Get expense analytics (Admin)'
        }
      }
    },
    
    authentication: {
      'POST /auth/login': 'User authentication',
      'POST /auth/logout': 'User logout',
      'GET /auth/profile': 'Get user profile',
      'POST /auth/change-password': 'Change password'
    },
    
    analytics: {
      distribution: '/analytics/distribution/summary',
      transport: '/analytics/transport/summary', 
      warehouse: '/analytics/warehouse/summary'
    },
    
    notes: [
      'All modules are completely independent',
      'No cross-module data sharing',
      'Each module has its own analytics',
      'Role-based access ensures module isolation'
    ]
  });
});

// ================================
// ERROR HANDLING
// ================================

app.use(notFound);

// Prisma auto-reconnect error handler - catches "not yet connected" and reconnects
app.use(async (err, req, res, next) => {
  if (err && err.message && err.message.includes('not yet connected')) {
    console.log('⚠️ Prisma disconnected, reconnecting...');
    try {
      await prisma.$reconnect();
      res.status(503).json({ error: 'Database was reconnecting. Please retry your request.' });
    } catch (reconnectErr) {
      console.error('❌ Prisma reconnect failed:', reconnectErr.message);
      res.status(503).json({ error: 'Database temporarily unavailable. Please try again.' });
    }
  } else {
    next(err);
  }
});

app.use(errorHandler);

// ================================
// SERVER STARTUP
// ================================

const PORT = process.env.PORT || 3002;

// Connect to database BEFORE accepting requests
async function startServer() {
  // Retry Prisma connection up to 15 times (covers ~2 minutes of retries)
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await prisma.$connect();
      console.log('✅ Prisma connected to database');
      break;
    } catch (err) {
      console.error(`❌ Prisma connection attempt ${attempt}/15 failed:`, err.message);
      if (attempt < 15) {
        const delay = Math.min(2000 * attempt, 10000); // 2s, 4s, 6s, ... 10s max
        console.log(`   Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // If we can't connect after 15 tries, crash so Railway restarts us
        console.error('❌ Could not connect to database after 15 attempts. Exiting...');
        process.exit(1);
      }
    }
  }

  // ================================
  // PRISMA KEEPALIVE - prevent stale connections
  // ================================
  // Ping database every 2 minutes. If it fails, destroy and recreate the client.
  setInterval(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      console.log('⚠️ Prisma keepalive failed, creating fresh client...');
      await prisma.$reconnect();
    }
  }, 2 * 60 * 1000); // Every 2 minutes

  // ================================
  // START CRON JOBS (only after Prisma is connected)
  // ================================

  // Batch status management - daily at midnight
  cron.schedule('0 0 * * *', async () => {
    console.log('🕐 Running scheduled batch status management...');
    try {
      await manageBatchStatus();
    } catch (error) {
      console.error('❌ Scheduled job failed:', error);
    }
  });

  // Inventory auto-sync (every 5 min) + hourly audit + daily integrity
  startInventorySyncCron();

  // Customer balance reconciliation - every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await reconcileCustomerBalances();
    } catch (error) {
      console.error('❌ Customer balance reconciliation failed:', error);
    }
  });

  console.log('✅ All cron jobs started (after Prisma connected)');

  // Run initial checks after a short delay
  setTimeout(async () => {
    try {
      console.log('🚀 Running initial batch status check...');
      await manageBatchStatus();
      console.log('🚀 Running initial customer balance reconciliation...');
      await reconcileCustomerBalances();
    } catch (error) {
      console.error('❌ Initial startup checks failed:', error);
    }
  }, 5000);

  const server = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Premium G Enterprise System                   ║
║                      STANDALONE MODULES v2.0                    ║
╠══════════════════════════════════════════════════════════════════╣
║  🚀 Server running on port: ${PORT}                                ║
║  📊 Environment: ${process.env.NODE_ENV || 'development'}                        ║
║  🌐 Health check: http://localhost:${PORT}/health                 ║
║  📚 API docs: http://localhost:${PORT}/api/v1/docs                ║
╠══════════════════════════════════════════════════════════════════╣
║  MODULE STATUS:                                                  ║
║  📈 Distribution: Active & Standalone                           ║
║  🚛 Transport: Active & Standalone                              ║
║  📦 Warehouse: Active & Standalone                              ║
╚══════════════════════════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      console.log('Server shut down successfully');
      process.exit(0);
    });
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(async () => {
      await prisma.$disconnect();
      console.log('Server shut down successfully');
      process.exit(0);
    });
  });
}

startServer();

module.exports = app;