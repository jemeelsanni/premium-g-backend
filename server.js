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
const truckRoutes = require('./routes/trucks');

// Import new enhanced routes
const targetRoutes = require('./routes/targets'); // Target management
const expenseRoutes = require('./routes/expenses'); // Expense management
const profitAnalysisRoutes = require('./routes/profit-analysis'); // Profit analysis

// Import middleware
const { authenticateToken, authorizeRole } = require('./middleware/auth');
const { auditLogger } = require('./middleware/auditLogger');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3001;

// ================================
// MIDDLEWARE SETUP
// ================================

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

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
  skip: (req) => {
    // Skip rate limiting for health checks and auth verification
    return req.path === '/health' || req.path.includes('/auth/verify-token');
  }
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// API routes
const apiVersion = process.env.API_VERSION || 'v1';


// Audit logging middleware (for authenticated routes)
app.use('/api/', auditLogger);

// ================================
// ROUTES
// ================================

// Health check endpoint with system status
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '2.0.0', // Updated version with enhanced features
    features: {
      targetManagement: true,
      expenseTracking: true,
      profitAnalysis: true,
      auditLogging: true,
      roleBasedAccess: true
    },
    database: {
      status: 'connected',
      provider: 'postgresql'
    }
  });
});

/// System status endpoint (Admin only)
app.get(`/api/${apiVersion}/system/status`, 
  authenticateToken, 
  authorizeRole(['SUPER_ADMIN']),
  async (req, res) => {
    try {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      
      // Test database connection
      await prisma.$queryRaw`SELECT 1`;
      
      // Get actual dashboard metrics
      const [
        totalOrders,
        activeDeliveries,
        warehouseStock,
        totalRevenue,
        recentOrders,
        recentTransportOrders,
        expenses,
        recentAuditLogs
      ] = await Promise.all([
        // Total orders (distribution + transport)
        Promise.all([
          prisma.distributionOrder.count(),
          prisma.transportOrder.count()
        ]).then(([dist, trans]) => dist + trans),
        
        // Active deliveries
        Promise.all([
          prisma.distributionOrder.count({
            where: { status: { in: ['PROCESSING', 'PENDING'] } }
          }),
          prisma.transportOrder.count({
            where: { deliveryStatus: 'IN_TRANSIT' }
          })
        ]).then(([dist, trans]) => dist + trans),
        
        // Warehouse stock (total packs)
        prisma.warehouseInventory.aggregate({
          _sum: { packs: true }
        }).then(result => result._sum.packs || 0),
        
        // Total revenue - Convert Decimal to number
        Promise.all([
          prisma.distributionOrder.aggregate({
            _sum: { finalAmount: true }
          }),
          prisma.transportOrder.aggregate({
            _sum: { totalOrderAmount: true }
          }),
          prisma.warehouseSale.aggregate({
            _sum: { totalAmount: true }
          })
        ]).then(([dist, trans, warehouse]) => {
          // Convert Decimal objects to numbers using parseFloat
          const distAmount = parseFloat(dist._sum.finalAmount || 0);
          const transAmount = parseFloat(trans._sum.totalOrderAmount || 0);
          const warehouseAmount = parseFloat(warehouse._sum.totalAmount || 0);
          return distAmount + transAmount + warehouseAmount;
        }),
        
        // Recent distribution orders
        prisma.distributionOrder.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            location: true,
            customer: true,
            createdByUser: { select: { username: true } }
          }
        }),
        
        // Recent transport orders
        prisma.transportOrder.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            location: true,
            truck: true,
            distributionOrder: true,
            createdByUser: { select: { username: true } }
          }
        }),
        
        // Recent expenses
        prisma.expense.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            createdByUser: { select: { username: true } },
            approver: { select: { username: true } }
          }
        }),
        
        // Recent audit logs
        prisma.auditLog.findMany({
          take: 10,
          where: {
            createdAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
            }
          },
          orderBy: { createdAt: 'desc' },
          include: {
            user: { select: { username: true } }
          }
        })
      ]);

      await prisma.$disconnect();

      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        data: {
          totalOrders,
          activeDeliveries,
          warehouseStock,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),  // Now totalRevenue is a number
          recentOrders,
          recentTransportOrders,
          expenses,
          recentAuditLogs
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
  }
);


// Authentication routes (public)
app.use(`/api/${apiVersion}/auth`, authRoutes);

// Protected routes (require authentication)
app.use(`/api/${apiVersion}/users`, authenticateToken, userRoutes);
app.use(`/api/${apiVersion}/distribution`, authenticateToken, distributionRoutes);
app.use(`/api/${apiVersion}/transport`, authenticateToken, transportRoutes);
app.use(`/api/${apiVersion}/warehouse`, authenticateToken, warehouseRoutes);
app.use(`/api/${apiVersion}/transport`, authenticateToken, truckRoutes);

// Enhanced routes (new features)
app.use(`/api/${apiVersion}/targets`, authenticateToken, targetRoutes);
app.use(`/api/${apiVersion}/expenses`, authenticateToken, expenseRoutes);
app.use(`/api/${apiVersion}/analytics/profit`, authenticateToken, profitAnalysisRoutes);

// Admin routes (Super Admin only)
app.use(`/api/${apiVersion}/admin`, authenticateToken, authorizeRole(['SUPER_ADMIN']), adminRoutes);

// API documentation endpoint
app.get(`/api/${apiVersion}/docs`, (req, res) => {
  res.json({
    title: 'Premium G Enterprise Management System API',
    version: '2.0.0',
    description: 'Comprehensive enterprise management system for distribution, transport, and warehouse operations',
    endpoints: {
      authentication: {
        'POST /auth/login': 'User authentication',
        'POST /auth/logout': 'User logout',
        'POST /auth/register': 'Register new user (Admin only)',
        'POST /auth/change-password': 'Change user password',
        'GET /auth/profile': 'Get user profile',
        'GET /auth/sessions': 'Get user sessions',
        'POST /auth/verify-token': 'Verify JWT token'
      },
      distribution: {
        'GET /distribution/orders': 'Get distribution orders',
        'POST /distribution/orders': 'Create distribution order',
        'GET /distribution/orders/:id': 'Get specific order',
        'PUT /distribution/orders/:id': 'Update order',
        'POST /distribution/orders/:id/price-adjustments': 'Create price adjustment',
        'GET /distribution/analytics/summary': 'Get distribution analytics'
      },
      transport: {
        'GET /transport/orders': 'Get transport orders',
        'POST /transport/orders': 'Create transport order',
        'GET /transport/orders/:id': 'Get specific transport order',
        'PUT /transport/orders/:id': 'Update transport order',
        'PUT /transport/orders/:id/expenses': 'Update truck expenses',
        'GET /transport/analytics/profit-analysis': 'Get transport profit analysis'
      },
      warehouse: {
        'GET /warehouse/inventory': 'Get inventory',
        'PUT /warehouse/inventory/:id': 'Update inventory',
        'GET /warehouse/sales': 'Get warehouse sales',
        'POST /warehouse/sales': 'Create warehouse sale',
        'GET /warehouse/cash-flow': 'Get cash flow entries',
        'POST /warehouse/cash-flow': 'Create cash flow entry',
        'GET /warehouse/analytics/summary': 'Get warehouse analytics'
      },
      targets: {
        'GET /targets': 'Get distribution targets',
        'POST /targets': 'Set monthly target (Admin)',
        'GET /targets/current': 'Get current month target',
        'GET /performance/weekly': 'Get weekly performance',
        'PUT /performance/weekly/:id': 'Update weekly performance (Admin)',
        'GET /performance/dashboard': 'Get performance dashboard',
        'POST /performance/recalculate': 'Recalculate performance (Admin)'
      },
      expenses: {
        'GET /expenses': 'Get expenses',
        'POST /expenses': 'Create expense',
        'GET /expenses/:id': 'Get specific expense',
        'PUT /expenses/:id': 'Update expense',
        'POST /expenses/:id/approve': 'Approve/reject expense (Admin)',
        'DELETE /expenses/:id': 'Delete expense',
        'POST /expenses/bulk-approve': 'Bulk approve expenses (Admin)',
        'GET /expenses/analytics/summary': 'Get expense analytics (Admin)'
      },
      profitAnalysis: {
        'GET /analytics/profit/order/:orderId': 'Get order profit analysis',
        'GET /analytics/profit/monthly': 'Get monthly profit analysis (Admin)',
        'GET /analytics/profit/yearly': 'Get yearly profit analysis (Admin)',
        'GET /analytics/profit/location/:locationId': 'Get location profit analysis (Admin)',
        'GET /analytics/profit/customer/:customerId': 'Get customer profit analysis (Admin)',
        'GET /analytics/profit/dashboard': 'Get profit dashboard (Admin)',
        'POST /analytics/profit/recalculate': 'Recalculate profit analysis (Super Admin)'
      },
      admin: {
        'GET /admin/dashboard': 'Get admin dashboard',
        'GET /admin/products': 'Get products',
        'POST /admin/products': 'Create product',
        'GET /admin/customers': 'Get customers',
        'POST /admin/customers': 'Create customer',
        'GET /admin/locations': 'Get locations',
        'POST /admin/locations': 'Create location',
        'GET /admin/audit-trail': 'Get audit trail',
        'GET /admin/system-config': 'Get system configuration',
        'PUT /admin/system-config/:key': 'Update system configuration',
        'GET /admin/reports/consolidated': 'Get consolidated business report',
        'GET /admin/reports/performance': 'Get performance report'
      },
      users: {
        'GET /users': 'Get users (Admin)',
        'GET /users/:id': 'Get specific user',
        'PUT /users/:id': 'Update user (Super Admin)',
        'DELETE /users/:id': 'Deactivate user (Super Admin)',
        'GET /users/:id/activity': 'Get user activity',
        'GET /users/stats/summary': 'Get user statistics (Admin)'
      }
    },
    authentication: {
      type: 'JWT Bearer Token',
      header: 'Authorization: Bearer <token>',
      loginEndpoint: `/api/${apiVersion}/auth/login`
    },
    roles: {
      'SUPER_ADMIN': 'Full system access',
      'DISTRIBUTION_ADMIN': 'Distribution module admin access',
      'TRANSPORT_ADMIN': 'Transport module admin access',
      'WAREHOUSE_ADMIN': 'Warehouse module admin access',
      'DISTRIBUTION_SALES_REP': 'Distribution sales operations',
      'WAREHOUSE_SALES_OFFICER': 'Warehouse sales operations',
      'CASHIER': 'Cash flow operations',
      'TRANSPORT_STAFF': 'Transport operations'
    },
    features: {
      'Target Management': 'Set and track monthly/weekly distribution targets',
      'Expense Tracking': 'Comprehensive expense management with approval workflows',
      'Profit Analysis': 'Detailed profit/loss calculations and analytics',
      'Audit Logging': 'Complete activity tracking and audit trails',
      'Role-Based Access': 'Granular permissions based on user roles',
      'Real-time Analytics': 'Live dashboards and performance metrics',
      'Location-based Pricing': 'Dynamic pricing based on delivery location',
      'Multi-level Reporting': 'Order, customer, location, and period-based reports'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString(),
    suggestion: `Visit /api/${apiVersion}/docs for available endpoints`
  });
});

// Error handling middleware
app.use(errorHandler);

// ================================
// SERVER STARTUP & GRACEFUL SHUTDOWN
// ================================

// Graceful shutdown handlers
const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  server.close((err) => {
    if (err) {
      console.error('Error during server shutdown:', err);
      process.exit(1);
    }
    
    console.log('Server closed successfully');
    
    // Close database connections
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    prisma.$disconnect()
      .then(() => {
        console.log('Database connections closed');
        process.exit(0);
      })
      .catch((err) => {
        console.error('Error closing database connections:', err);
        process.exit(1);
      });
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Premium G Enterprise Management System v2.0
===============================================
📡 Server running on port ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
📋 API Version: ${apiVersion}
📚 Documentation: http://localhost:${PORT}/api/${apiVersion}/docs
🏥 Health Check: http://localhost:${PORT}/health
⏰ Started at: ${new Date().toISOString()}

✨ Enhanced Features:
   📊 Target & Performance Tracking
   💰 Comprehensive Expense Management  
   📈 Advanced Profit Analysis
   🔍 Detailed Audit Logging
   🎯 Role-Based Access Control
   📋 Real-time Analytics Dashboard

🔐 Default Admin Credentials:
   Username: superadmin
   Password: SuperAdmin123!
   
⚠️  IMPORTANT: Change default passwords in production!
===============================================
  `);

  // Test database connection on startup
  (async () => {
    try {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      console.log('✅ Database connection successful');
      await prisma.$disconnect();
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
    }
  })();
});

// Export app for testing
module.exports = app;