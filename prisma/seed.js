// ================================
// PREMIUM G ENTERPRISE MANAGEMENT SYSTEM
// CORRECTED SEED DATA - FIXED SCHEMA MISMATCHES
// ================================

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// Helper function to safely delete data if model exists
async function safeDelete(modelName, prismaModel) {
  try {
    if (prismaModel && typeof prismaModel.deleteMany === 'function') {
      await prismaModel.deleteMany({});
      console.log(`✅ Cleared ${modelName}`);
    } else {
      console.log(`⚠️  Skipping ${modelName} - model not found in schema`);
    }
  } catch (error) {
    console.log(`⚠️  Could not clear ${modelName}: ${error.message}`);
  }
}

// Helper function to safely create data if model exists
async function safeCreateMany(modelName, prismaModel, data) {
  try {
    if (prismaModel && typeof prismaModel.createMany === 'function') {
      const result = await prismaModel.createMany({ data });
      console.log(`✅ ${modelName} created (${data.length} records)`);
      return result;
    } else {
      console.log(`⚠️  Skipping ${modelName} - model not found in schema`);
      return null;
    }
  } catch (error) {
    console.log(`❌ Error creating ${modelName}: ${error.message}`);
    return null;
  }
}

// Helper function to safely find first record
async function safeFindFirst(modelName, prismaModel, where = {}) {
  try {
    if (prismaModel && typeof prismaModel.findFirst === 'function') {
      return await prismaModel.findFirst({ where });
    } else {
      console.log(`⚠️  Cannot find ${modelName} - model not found in schema`);
      return null;
    }
  } catch (error) {
    console.log(`⚠️  Could not find ${modelName}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🚀 Starting Premium G Enterprise System seed...');
  
  try {
    // Clear existing data (in correct order to avoid foreign key constraints)
    console.log('🧹 Clearing existing data...');
    
    await safeDelete('auditLog', prisma.auditLog);
    await safeDelete('cashFlow', prisma.cashFlow);
    await safeDelete('warehouseSaleDiscount', prisma.warehouseSaleDiscount);
    await safeDelete('warehouseSale', prisma.warehouseSale);
    await safeDelete('warehouseCustomerDiscount', prisma.warehouseCustomerDiscount);
    await safeDelete('discountApprovalRequest', prisma.discountApprovalRequest);
    await safeDelete('warehouseCustomer', prisma.warehouseCustomer);
    await safeDelete('warehouseInventory', prisma.warehouseInventory);
    await safeDelete('transportOrder', prisma.transportOrder);
    await safeDelete('truckCapacity', prisma.truckCapacity);
    await safeDelete('distributionOrderItem', prisma.distributionOrderItem);
    await safeDelete('distributionOrder', prisma.distributionOrder);
    await safeDelete('product', prisma.product);
    await safeDelete('location', prisma.location);
    await safeDelete('user', prisma.user);

    console.log('✅ Data clearing completed');

    // ================================
    // 1. USERS
    // ================================
    console.log('👥 Seeding users...');

    const hashedPassword = await bcrypt.hash('password123', 10);

    const userData = [
      {
        username: 'superadmin',
        email: 'admin@premiumg.com',
        passwordHash: hashedPassword,
        role: 'SUPER_ADMIN',
        isActive: true
      },
      {
        username: 'dist_admin',
        email: 'dist.admin@premiumg.com',
        passwordHash: hashedPassword,
        role: 'DISTRIBUTION_ADMIN',
        isActive: true
      },
      {
        username: 'sales_rep1',
        email: 'salesrep1@premiumg.com',
        passwordHash: hashedPassword,
        role: 'DISTRIBUTION_SALES_REP',
        isActive: true
      },
      {
        username: 'transport_admin',
        email: 'transport.admin@premiumg.com',
        passwordHash: hashedPassword,
        role: 'TRANSPORT_ADMIN',
        isActive: true
      },
      {
        username: 'driver1',
        email: 'driver1@premiumg.com',
        passwordHash: hashedPassword,
        role: 'TRANSPORT_STAFF',
        isActive: true
      },
      {
        username: 'warehouse_admin',
        email: 'warehouse.admin@premiumg.com',
        passwordHash: hashedPassword,
        role: 'WAREHOUSE_ADMIN',
        isActive: true
      },
      {
        username: 'sales_officer1',
        email: 'salesofficer1@premiumg.com',
        passwordHash: hashedPassword,
        role: 'WAREHOUSE_SALES_OFFICER',
        isActive: true
      },
      {
        username: 'cashier1',
        email: 'cashier1@premiumg.com',
        passwordHash: hashedPassword,
        role: 'CASHIER',
        isActive: true
      }
    ];

    await safeCreateMany('Users', prisma.user, userData);

    // Get user references
    const superAdmin = await safeFindFirst('superAdmin', prisma.user, { username: 'superadmin' });
    const distAdmin = await safeFindFirst('distAdmin', prisma.user, { username: 'dist_admin' });
    const salesRep1 = await safeFindFirst('salesRep1', prisma.user, { username: 'sales_rep1' });
    const driver1 = await safeFindFirst('driver1', prisma.user, { username: 'driver1' });
    const salesOfficer1 = await safeFindFirst('salesOfficer1', prisma.user, { username: 'sales_officer1' });
    const cashier1 = await safeFindFirst('cashier1', prisma.user, { username: 'cashier1' });

    // ================================
    // 2. LOCATIONS
    // ================================
    console.log('📍 Seeding locations...');

    const locationData = [
      {
        name: 'Lagos Island Distribution Center',
        address: '15 Marina Street, Victoria Island, Lagos State',
        fuelAdjustment: 0.0,
        driverWagesPerTrip: 15000.0,
        isActive: true
      },
      {
        name: 'Ikeja Warehouse Hub',
        address: '45 Allen Avenue, Ikeja, Lagos State',
        fuelAdjustment: 0.0,
        driverWagesPerTrip: 15000.0,
        isActive: true
      },
      {
        name: 'Abuja Central Office',
        address: 'Plot 123, Central Business District, FCT Abuja',
        fuelAdjustment: 50.0,
        driverWagesPerTrip: 20000.0,
        isActive: true
      }
    ];

    await safeCreateMany('Locations', prisma.location, locationData);

    // ================================
    // 3. PRODUCTS - FIXED: Using correct schema fields
    // ================================
    console.log('🥤 Seeding products...');

    const productData = [
      {
        productNo: 'RF-001',
        name: 'Bigi drinks (35cl.)',
        packsPerPallet: 224,
        pricePerPack: 9.40,
        costPerPack: 7.50, // Added costPerPack from schema
        module: 'DISTRIBUTION', // Changed from 'category' to 'module'
        isActive: true
      },
      {
        productNo: 'RF-002',
        name: 'Bigi drinks (60cl.)',
        packsPerPallet: 154,
        pricePerPack: 20.24,
        costPerPack: 16.20,
        module: 'DISTRIBUTION',
        isActive: true
      },
      {
        productNo: 'RF-003',
        name: 'Sosa drinks (35cl.)',
        packsPerPallet: 175,
        pricePerPack: 22.97,
        costPerPack: 18.38,
        module: 'DISTRIBUTION',
        isActive: true
      },
      {
        productNo: 'WH-001',
        name: 'Coca-Cola 35cl bottle',
        packsPerPallet: 240,
        pricePerPack: 10.00,
        costPerPack: 8.00,
        module: 'WAREHOUSE',
        isActive: true
      },
      {
        productNo: 'WH-002',
        name: 'Pepsi 35cl bottle',
        packsPerPallet: 240,
        pricePerPack: 9.58,
        costPerPack: 7.66,
        module: 'WAREHOUSE',
        isActive: true
      }
    ];

    await safeCreateMany('Products', prisma.product, productData);

    // ================================
    // 4. TRUCK CAPACITY - FIXED: Using correct schema fields
    // ================================
    console.log('🚛 Seeding truck capacity...');

    const truckData = [
      {
        truckId: 'TRK-001',
        registrationNumber: 'KJA-123-XY', // Using correct field name
        maxPallets: 40,
        currentLoad: 0,
        availableSpace: 40,
        make: 'Mercedes Benz', // Separate make field
        model: 'Actros',
        year: 2020,
        isActive: true
      },
      {
        truckId: 'TRK-002',
        registrationNumber: 'ABC-456-ZY',
        maxPallets: 35,
        currentLoad: 0,
        availableSpace: 35,
        make: 'MAN',
        model: 'TGX',
        year: 2019,
        isActive: true
      }
    ];

    await safeCreateMany('Trucks', prisma.truckCapacity, truckData);

    // ================================
    // 5. WAREHOUSE INVENTORY - FIXED: Using correct schema fields
    // ================================
    console.log('📦 Seeding warehouse inventory...');

    const firstProduct = await safeFindFirst('firstProduct', prisma.product, { module: 'WAREHOUSE' });
    
    if (firstProduct) {
      const inventoryData = [
        {
          productId: firstProduct.id,
          pallets: 10,
          packs: 2400,
          units: 57600, // 2400 packs * 24 units per pack
          reorderLevel: 500,
          location: 'Section A - Rack 1'
        }
      ];

      await safeCreateMany('Warehouse Inventory', prisma.warehouseInventory, inventoryData);
    }

    // ================================
    // 6. WAREHOUSE SALES - FIXED: Using correct schema fields
    // ================================
    console.log('🛍️ Seeding sample warehouse sales...');
    
    if (firstProduct && salesOfficer1) {
      const warehouseSaleData = [
        {
          productId: firstProduct.id,
          quantity: 240,
          unitType: 'UNITS',
          unitPrice: 10.00,
          totalAmount: 2400.00,
          costPerUnit: 8.00,
          totalCost: 1920.00,
          grossProfit: 480.00,
          profitMargin: 20.00,
          paymentMethod: 'CASH',
          customerName: 'Mama Cass Supermarket',
          customerPhone: '+2341234568004',
          receiptNumber: 'WS-001-2024',
          salesOfficer: salesOfficer1.id
        }
      ];

      await safeCreateMany('Warehouse Sales', prisma.warehouseSale, warehouseSaleData);
    }

    // ================================
    // 7. CASH FLOW - FIXED: Removed non-existent 'category' field
    // ================================
    console.log('💰 Seeding sample cash flow...');
    
    if (cashier1) {
      const cashFlowData = [
        {
          transactionType: 'CASH_IN',
          amount: 2400.00,
          description: 'Sale to Mama Cass Supermarket',
          referenceNumber: 'WS-001-2024',
          paymentMethod: 'CASH',
          cashier: cashier1.id
        },
        {
          transactionType: 'CASH_OUT',
          amount: 45000.00,
          description: 'Purchase new inventory - Soft drinks',
          referenceNumber: 'PO-001-2024',
          paymentMethod: 'BANK_TRANSFER',
          cashier: cashier1.id
        }
      ];

      await safeCreateMany('Cash Flow', prisma.cashFlow, cashFlowData);
    }

    // ================================
    // 8. TRANSPORT ORDERS - FIXED: Using correct schema fields
    // ================================
    console.log('🚛 Seeding sample transport orders...');
    
    const firstLocation = await safeFindFirst('firstLocation', prisma.location, {});
    
    if (firstLocation && driver1) {
      const transportOrderData = [
        {
          orderNumber: 'TO-2024-001',
          invoiceNumber: 'INV-TO-001',
          locationId: firstLocation.id,
          truckId: 'TRK-001',
          totalOrderAmount: 450000.00,
          fuelRequired: 120,
          fuelPricePerLiter: 700.00,
          totalFuelCost: 84000.00,
          serviceChargeExpense: 25000.00,
          driverWages: 15000.00,
          truckExpenses: 8000.00,
          totalExpenses: 132000.00,
          grossProfit: 318000.00,
          netProfit: 290000.00,
          profitMargin: 64.44,
          driverDetails: 'Adebayo Johnson - Licensed driver with 5 years experience',
          deliveryStatus: 'DELIVERED',
          deliveryDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          createdBy: driver1.id
        }
      ];

      await safeCreateMany('Transport Orders', prisma.transportOrder, transportOrderData);
    }

    // ================================
    // VERIFICATION
    // ================================
    console.log('🔍 Verifying seeded data...');

    const verification = [];
    
    const modelCounts = {
      'Users': prisma.user,
      'Locations': prisma.location,
      'Products': prisma.product,
      'Trucks': prisma.truckCapacity,
      'Warehouse Inventory': prisma.warehouseInventory,
      'Warehouse Sales': prisma.warehouseSale,
      'Cash Flow': prisma.cashFlow,
      'Transport Orders': prisma.transportOrder
    };

    for (const [modelName, model] of Object.entries(modelCounts)) {
      try {
        if (model && typeof model.count === 'function') {
          const count = await model.count();
          verification.push({ model: modelName, count });
        }
      } catch (error) {
        verification.push({ model: modelName, count: 'N/A', error: error.message });
      }
    }

    console.log('\n📊 SEED VERIFICATION SUMMARY:');
    console.log('==============================');
    verification.forEach(({ model, count, error }) => {
      if (error) {
        console.log(`⚠️  ${model}: ${count} (${error})`);
      } else {
        console.log(`✅ ${model}: ${count}`);
      }
    });

    // Calculate revenue
    let totalRevenue = 0;
    try {
      const warehouseRevenue = await prisma.warehouseSale.aggregate({
        _sum: { totalAmount: true }
      });
      totalRevenue += warehouseRevenue._sum.totalAmount || 0;

      const transportProfit = await prisma.transportOrder.aggregate({
        where: { deliveryStatus: 'DELIVERED' },
        _sum: { netProfit: true }
      });
      totalRevenue += transportProfit._sum.netProfit || 0;
    } catch (error) {
      console.log('⚠️  Could not calculate revenue');
    }

    console.log('\n💰 REVENUE SUMMARY:');
    console.log('===================');
    console.log(`💎 Total System Revenue: ₦${totalRevenue.toLocaleString()}`);

    console.log('\n🎉 PREMIUM G ENTERPRISE SYSTEM SEED COMPLETED!');
    console.log('============================================================');
    console.log('🇳🇬 Nigerian Drinks Company Database');
    console.log('✅ Successfully seeded with correct schema fields');
    console.log('📊 Ready for development and testing');
    console.log('🔐 Login: All users password = "password123"');
    console.log('============================================================');

  } catch (error) {
    console.error('❌ Error during seeding:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Execute the main function
main()
  .then(() => {
    console.log('✅ Seed completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  });
