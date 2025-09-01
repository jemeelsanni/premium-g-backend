const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding...');

  // ================================
  // CLEAR EXISTING DATA (Development only)
  // ================================
  
  if (process.env.NODE_ENV === 'development') {
    console.log('🧹 Clearing existing data...');
    
    try {
      // Clear in correct order due to foreign key constraints
      await prisma.auditLog.deleteMany().catch(() => console.log('AuditLog table not found, skipping...'));
      await prisma.userSession.deleteMany().catch(() => console.log('UserSession table not found, skipping...'));
      await prisma.priceAdjustment.deleteMany().catch(() => console.log('PriceAdjustment table not found, skipping...'));
      await prisma.distributionOrderItem.deleteMany().catch(() => console.log('DistributionOrderItem table not found, skipping...'));
      await prisma.distributionOrder.deleteMany().catch(() => console.log('DistributionOrder table not found, skipping...'));
      await prisma.transportOrder.deleteMany().catch(() => console.log('TransportOrder table not found, skipping...'));
      await prisma.warehouseSale.deleteMany().catch(() => console.log('WarehouseSale table not found, skipping...'));
      await prisma.cashFlow.deleteMany().catch(() => console.log('CashFlow table not found, skipping...'));
      await prisma.warehouseInventory.deleteMany().catch(() => console.log('WarehouseInventory table not found, skipping...'));
      await prisma.palletPricing.deleteMany().catch(() => console.log('PalletPricing table not found, skipping...'));
      await prisma.truckCapacity.deleteMany().catch(() => console.log('TruckCapacity table not found, skipping...'));
      await prisma.product.deleteMany().catch(() => console.log('Product table not found, skipping...'));
      await prisma.customer.deleteMany().catch(() => console.log('Customer table not found, skipping...'));
      await prisma.location.deleteMany().catch(() => console.log('Location table not found, skipping...'));
      await prisma.user.deleteMany().catch(() => console.log('User table not found, skipping...'));
      await prisma.systemConfig.deleteMany().catch(() => console.log('SystemConfig table not found, skipping...'));
      
      console.log('✅ Existing data cleared (or tables were empty)');
    } catch (error) {
      console.log('⚠️ Some tables might not exist yet, continuing with seeding...');
    }
  }

  // ================================
  // CREATE SYSTEM CONFIGURATIONS
  // ================================

  console.log('⚙️ Creating system configurations...');

  // First create a system user for configurations
  const systemUserId = 'system-config-user';

  const configs = [
    {
      key: 'MAX_PALLETS_PER_TRUCK',
      value: 12,
      description: 'Maximum number of pallets per truck capacity',
      updatedBy: systemUserId
    },
    {
      key: 'DEFAULT_SERVICE_CHARGE_PERCENTAGE', 
      value: 10,
      description: 'Default service charge percentage for transportation',
      updatedBy: systemUserId
    },
    {
      key: 'COMPANY_SETTINGS',
      value: {
        name: 'Premium G Enterprise',
        address: 'Lagos, Nigeria',
        phone: '+234-xxx-xxxx',
        email: 'info@premiumg.com'
      },
      description: 'Company information settings',
      updatedBy: systemUserId
    }
  ];

  for (const config of configs) {
    await prisma.systemConfig.create({
      data: config
    });
  }

  // ================================
  // CREATE USERS
  // ================================

  console.log('👥 Creating users...');

  const saltRounds = 12;
  const users = [
    {
      username: 'superadmin',
      email: 'admin@premiumg.com',
      password: 'SuperAdmin123!',
      role: 'SUPER_ADMIN'
    },
    {
      username: 'dist_admin',
      email: 'distribution.admin@premiumg.com',
      password: 'DistAdmin123!',
      role: 'DISTRIBUTION_ADMIN'
    },
    {
      username: 'transport_admin',
      email: 'transport.admin@premiumg.com',
      password: 'TransAdmin123!',
      role: 'TRANSPORT_ADMIN'
    },
    {
      username: 'warehouse_admin',
      email: 'warehouse.admin@premiumg.com',
      password: 'WareAdmin123!',
      role: 'WAREHOUSE_ADMIN'
    },
    {
      username: 'sales_rep_1',
      email: 'sales1@premiumg.com',
      password: 'SalesRep123!',
      role: 'DISTRIBUTION_SALES_REP'
    },
    {
      username: 'sales_rep_2',
      email: 'sales2@premiumg.com',
      password: 'SalesRep123!',
      role: 'DISTRIBUTION_SALES_REP'
    },
    {
      username: 'warehouse_officer',
      email: 'warehouse.officer@premiumg.com',
      password: 'WareOfficer123!',
      role: 'WAREHOUSE_SALES_OFFICER'
    },
    {
      username: 'cashier_1',
      email: 'cashier@premiumg.com',
      password: 'Cashier123!',
      role: 'CASHIER'
    },
    {
      username: 'transport_staff',
      email: 'transport.staff@premiumg.com',
      password: 'TransStaff123!',
      role: 'TRANSPORT_STAFF'
    }
  ];

  const createdUsers = {};

  for (const userData of users) {
    const passwordHash = await bcrypt.hash(userData.password, saltRounds);
    const user = await prisma.user.create({
      data: {
        username: userData.username,
        email: userData.email,
        passwordHash,
        role: userData.role,
        isActive: true
      }
    });
    createdUsers[userData.username] = user;
    console.log(`✅ Created user: ${userData.username} (${userData.role})`);
  }

  // ================================
  // CREATE LOCATIONS
  // ================================

  console.log('📍 Creating delivery locations...');

  const locations = [
    {
      name: 'Lagos Central',
      address: 'Victoria Island, Lagos State',
      fuelAdjustment: 0.00 // No adjustment for central location
    },
    {
      name: 'Ibadan',
      address: 'Ibadan, Oyo State',
      fuelAdjustment: 5.00 // 5% fuel adjustment
    },
    {
      name: 'Abuja',
      address: 'Central Business District, Abuja',
      fuelAdjustment: 8.00 // 8% fuel adjustment
    },
    {
      name: 'Port Harcourt',
      address: 'Port Harcourt, Rivers State',
      fuelAdjustment: 7.00 // 7% fuel adjustment
    },
    {
      name: 'Kano',
      address: 'Kano, Kano State',
      fuelAdjustment: 12.00 // 12% fuel adjustment
    },
    {
      name: 'Benin City',
      address: 'Benin City, Edo State',
      fuelAdjustment: 6.00 // 6% fuel adjustment
    }
  ];

  const createdLocations = {};

  for (const locationData of locations) {
    const location = await prisma.location.create({
      data: locationData
    });
    createdLocations[locationData.name] = location;
    console.log(`✅ Created location: ${locationData.name}`);
  }

  // ================================
  // CREATE CUSTOMERS
  // ================================

  console.log('🏢 Creating customers...');

  const customers = [
    {
      name: 'ABC Supermarket Ltd',
      email: 'orders@abcsupermarket.com',
      phone: '+234-801-234-5678',
      address: '123 Market Street, Lagos'
    },
    {
      name: 'XYZ Trading Company',
      email: 'procurement@xyztrading.com',
      phone: '+234-802-345-6789',
      address: '45 Commercial Avenue, Ibadan'
    },
    {
      name: 'Premium Retailers',
      email: 'orders@premiumretailers.com',
      phone: '+234-803-456-7890',
      address: '78 Business District, Abuja'
    },
    {
      name: 'Metro Foods Ltd',
      email: 'supply@metrofoods.com',
      phone: '+234-804-567-8901',
      address: '90 Industrial Layout, Port Harcourt'
    },
    {
      name: 'Northern Distributors',
      email: 'orders@northerndist.com',
      phone: '+234-805-678-9012',
      address: '12 Trade Centre, Kano'
    }
  ];

  const createdCustomers = {};

  for (const customerData of customers) {
    const customer = await prisma.customer.create({
      data: customerData
    });
    createdCustomers[customerData.name] = customer;
    console.log(`✅ Created customer: ${customerData.name}`);
  }

  // ================================
  // CREATE PRODUCTS (Rite Foods Ltd products)
  // ================================

  console.log('📦 Creating Rite Foods products...');

  const products = [
    {
      productNo: 'RF001',
      name: 'Rite Foods Bigi Cola - 50cl',
      description: 'Premium cola drink 50cl bottles',
      packsPerPallet: 24,
      pricePerPack: 120.00
    },
    {
      productNo: 'RF002',
      name: 'Rite Foods Bigi Cola - 35cl',
      description: 'Premium cola drink 35cl bottles',
      packsPerPallet: 36,
      pricePerPack: 100.00
    },
     {
      productNo: 'RF003',
      name: 'Rite Foods Bigi Lemon - 50cl',
      description: 'Premium cola drink 50cl bottles',
      packsPerPallet: 24,
      pricePerPack: 120.00
    },
    {
      productNo: 'RF004',
      name: 'Rite Foods Bigi Lemon - 35cl',
      description: 'Premium cola drink 35cl bottles',
      packsPerPallet: 36,
      pricePerPack: 100.00
    },
     {
      productNo: 'RF005',
      name: 'Rite Foods Bigi Chapman - 50cl',
      description: 'Premium cola drink 50cl bottles',
      packsPerPallet: 24,
      pricePerPack: 120.00
    },
    {
      productNo: 'RF006',
      name: 'Rite Foods Bigi Chapman - 35cl',
      description: 'Premium cola drink 35cl bottles',
      packsPerPallet: 36,
      pricePerPack: 100.00
    },
     {
      productNo: 'RF007',
      name: 'Rite Foods Bigi Guava - 50cl',
      description: 'Premium cola drink 50cl bottles',
      packsPerPallet: 24,
      pricePerPack: 120.00
    },
    {
      productNo: 'RF008',
      name: 'Rite Foods Bigi Guava - 35cl',
      description: 'Premium cola drink 35cl bottles',
      packsPerPallet: 36,
      pricePerPack: 100.00
    },
    {
      productNo: 'RF009',
      name: 'Rite Foods Bigi Water - 50cl',
      description: 'Premium cola drink 35cl bottles',
      packsPerPallet: 36,
      pricePerPack: 100.00
    },
    {
      productNo: 'RF010',
      name: 'Rite Foods Fearless Energy Drink',
      description: 'Premium energy drink 25cl cans',
      packsPerPallet: 24,
      pricePerPack: 180.00
    }
  ];

  const createdProducts = {};

  for (const productData of products) {
    const product = await prisma.product.create({
      data: productData
    });
    createdProducts[productData.productNo] = product;
    console.log(`✅ Created product: ${productData.name} (${productData.productNo})`);
  }

  // ================================
  // CREATE PALLET PRICING (Location-specific)
  // ================================

  console.log('💰 Creating location-specific pricing...');

  const locationPricing = [
    // Ibadan pricing (5% fuel adjustment already in location)
    {
      productId: createdProducts['RF001'].id,
      locationId: createdLocations['Ibadan'].id,
      pricePerPack: 260.00,
      fuelAdjustment: 0.00 // Already included in price
    },
    // Abuja pricing (8% fuel adjustment already in location)  
    {
      productId: createdProducts['RF001'].id,
      locationId: createdLocations['Abuja'].id,
      pricePerPack: 270.00,
      fuelAdjustment: 0.00
    },
    // Kano pricing (12% fuel adjustment already in location)
    {
      productId: createdProducts['RF001'].id,
      locationId: createdLocations['Kano'].id,
      pricePerPack: 280.00,
      fuelAdjustment: 0.00
    }
  ];

  for (const pricingData of locationPricing) {
    await prisma.palletPricing.create({
      data: pricingData
    });
  }

  // ================================
  // CREATE TRUCK CAPACITY RECORDS
  // ================================

  console.log('🚚 Creating truck capacity records...');

  const trucks = [
    { truckId: 'PG-001', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-002', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-003', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-004', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-005', maxPallets: 12, currentLoad: 0 }
  ];

  const createdTrucks = {};

  for (const truckData of trucks) {
    const truck = await prisma.truckCapacity.create({
      data: {
        ...truckData,
        availableSpace: truckData.maxPallets - truckData.currentLoad
      }
    });
    createdTrucks[truckData.truckId] = truck;
    console.log(`✅ Created truck: ${truckData.truckId}`);
  }

  // ================================
  // CREATE WAREHOUSE INVENTORY
  // ================================

  console.log('📋 Creating warehouse inventory...');

  for (const [productNo, product] of Object.entries(createdProducts)) {
    await prisma.warehouseInventory.create({
      data: {
        productId: product.id,
        packs: Math.floor(Math.random() * 200) + 50,  // 50-249 packs
        units: Math.floor(Math.random() * 500) + 100, // 100-599 units
        reorderLevel: 20, // Reorder when below 20 packs
        maxStockLevel: 500,
        location: 'Main Warehouse'
      }
    });
  }

  console.log(`✅ Created inventory for ${Object.keys(createdProducts).length} products`);

  // ================================
  // CREATE SAMPLE DISTRIBUTION ORDERS
  // ================================

  console.log('📋 Creating sample distribution orders...');

  const sampleOrders = [
    {
      customerId: createdCustomers['ABC Supermarket Ltd'].id,
      locationId: createdLocations['Lagos Central'].id,
      createdBy: createdUsers['sales_rep_1'].id,
      status: 'DELIVERED',
      transporterCompany: 'Premium G Transport',
      driverNumber: 'DRV001',
      remark: 'Regular weekly order',
      orderItems: [
        {
          productId: createdProducts['RF001'].id,
          pallets: 2,
          packs: 10
        },
        {
          productId: createdProducts['RF004'].id,
          pallets: 1,
          packs: 5
        }
      ]
    },
    {
      customerId: createdCustomers['XYZ Trading Company'].id,
      locationId: createdLocations['Ibadan'].id,
      createdBy: createdUsers['sales_rep_2'].id,
      status: 'IN_TRANSIT',
      transporterCompany: 'Premium G Transport',
      driverNumber: 'DRV002',
      remark: 'Monthly bulk order',
      orderItems: [
        {
          productId: createdProducts['RF002'].id,
          pallets: 3,
          packs: 0
        },
        {
          productId: createdProducts['RF006'].id,
          pallets: 2,
          packs: 12
        }
      ]
    },
    {
      customerId: createdCustomers['Premium Retailers'].id,
      locationId: createdLocations['Abuja'].id,
      createdBy: createdUsers['sales_rep_1'].id,
      status: 'PENDING',
      remark: 'New product trial order',
      orderItems: [
        {
          productId: createdProducts['RF003'].id,
          pallets: 1,
          packs: 24
        }
      ]
    }
  ];

  for (const orderData of sampleOrders) {
    // Calculate totals
    let totalPallets = 0;
    let totalPacks = 0;
    let totalAmount = 0;
    const calculatedItems = [];

    for (const item of orderData.orderItems) {
      const product = await prisma.product.findUnique({
        where: { id: item.productId }
      });

      const palletPacks = item.pallets * product.packsPerPallet;
      const itemTotalPacks = palletPacks + item.packs;
      const itemAmount = itemTotalPacks * product.pricePerPack;

      calculatedItems.push({
        productId: item.productId,
        pallets: item.pallets,
        packs: item.packs,
        amount: itemAmount
      });

      totalPallets += item.pallets;
      totalPacks += itemTotalPacks;
      totalAmount += itemAmount;
    }

    // Create order
    await prisma.distributionOrder.create({
      data: {
        customerId: orderData.customerId,
        locationId: orderData.locationId,
        totalPallets,
        totalPacks,
        originalAmount: totalAmount,
        finalAmount: totalAmount,
        balance: 0,
        status: orderData.status,
        transporterCompany: orderData.transporterCompany,
        driverNumber: orderData.driverNumber,
        remark: orderData.remark,
        createdBy: orderData.createdBy,
        orderItems: {
          create: calculatedItems
        }
      }
    });
  }

  console.log(`✅ Created ${sampleOrders.length} sample distribution orders`);

  // ================================
  // CREATE SAMPLE TRANSPORT ORDERS
  // ================================

  console.log('🚛 Creating sample transport orders...');

  const sampleTransportOrders = [
    {
      orderNumber: 'TO-2025-001',
      invoiceNumber: 'INV-2025-001',
      locationId: createdLocations['Lagos Central'].id,
      truckId: 'PG-001',
      totalOrderAmount: 15000.00,
      fuelRequired: 45.5,
      fuelPricePerLiter: 650.00,
      driverDetails: 'John Adebayo - DRV001',
      deliveryStatus: 'DELIVERED',
      createdBy: createdUsers['transport_staff'].id
    },
    {
      orderNumber: 'TO-2025-002', 
      invoiceNumber: 'INV-2025-002',
      locationId: createdLocations['Ibadan'].id,
      truckId: 'PG-002',
      totalOrderAmount: 28000.00,
      fuelRequired: 85.0,
      fuelPricePerLiter: 650.00,
      driverDetails: 'Moses Ibrahim - DRV002',
      deliveryStatus: 'IN_TRANSIT',
      createdBy: createdUsers['transport_staff'].id
    }
  ];

  for (const transportData of sampleTransportOrders) {
    const totalFuelCost = transportData.fuelRequired * transportData.fuelPricePerLiter;
    const serviceCharge = transportData.totalOrderAmount * 0.10; // 10%

    await prisma.transportOrder.create({
      data: {
        ...transportData,
        totalFuelCost,
        serviceCharge,
        truckExpenses: 2500.00, // Sample truck expenses
        driverSalary: 8000.00   // Sample driver salary
      }
    });
  }

  console.log(`✅ Created ${sampleTransportOrders.length} sample transport orders`);

  // ================================
  // CREATE SAMPLE WAREHOUSE SALES
  // ================================

  console.log('🏪 Creating sample warehouse sales...');

  const sampleSales = [
    {
      productId: createdProducts['RF001'].id,
      quantity: 5,
      unitType: 'PACKS',
      unitPrice: 250.00,
      paymentMethod: 'CASH',
      customerName: 'Walk-in Customer',
      receiptNumber: 'WH-2025-001',
      salesOfficer: createdUsers['warehouse_officer'].id
    },
    {
      productId: createdProducts['RF004'].id,
      quantity: 24,
      unitType: 'UNITS',
      unitPrice: 120.00,
      paymentMethod: 'BANK_TRANSFER',
      customerName: 'Local Retailer',
      customerPhone: '+234-xxx-xxx-xxxx',
      receiptNumber: 'WH-2025-002',
      salesOfficer: createdUsers['warehouse_officer'].id
    }
  ];

  for (const saleData of sampleSales) {
    await prisma.warehouseSale.create({
      data: {
        ...saleData,
        totalAmount: saleData.quantity * saleData.unitPrice
      }
    });
  }

  console.log(`✅ Created ${sampleSales.length} sample warehouse sales`);

  // ================================
  // CREATE SAMPLE CASH FLOW ENTRIES
  // ================================

  console.log('💰 Creating sample cash flow entries...');

  const sampleCashFlow = [
    {
      transactionType: 'CASH_IN',
      amount: 1250.00,
      paymentMethod: 'CASH',
      description: 'Warehouse sale - Receipt WH-2025-001',
      referenceNumber: 'WH-2025-001',
      cashier: createdUsers['cashier_1'].id
    },
    {
      transactionType: 'CASH_IN',
      amount: 240.00,
      paymentMethod: 'BANK_TRANSFER',
      description: 'Warehouse sale - Receipt WH-2025-002', 
      referenceNumber: 'WH-2025-002',
      cashier: createdUsers['cashier_1'].id
    },
    {
      transactionType: 'CASH_OUT',
      amount: 500.00,
      paymentMethod: 'CASH',
      description: 'Office supplies purchase',
      cashier: createdUsers['cashier_1'].id
    }
  ];

  for (const cashFlowData of sampleCashFlow) {
    await prisma.cashFlow.create({
      data: cashFlowData
    });
  }

  console.log(`✅ Created ${sampleCashFlow.length} sample cash flow entries`);

  // ================================
  // FINAL SUMMARY
  // ================================

  console.log('\n🎉 Database seeding completed successfully!');
  console.log('\n📊 SEEDING SUMMARY:');
  console.log('===================');
  console.log(`👥 Users: ${users.length}`);
  console.log(`📍 Locations: ${locations.length}`);
  console.log(`🏢 Customers: ${customers.length}`);
  console.log(`📦 Products: ${products.length}`);
  console.log(`🚚 Trucks: ${trucks.length}`);
  console.log(`📋 Distribution Orders: ${sampleOrders.length}`);
  console.log(`🚛 Transport Orders: ${sampleTransportOrders.length}`);
  console.log(`🏪 Warehouse Sales: ${sampleSales.length}`);
  console.log(`💰 Cash Flow Entries: ${sampleCashFlow.length}`);

  console.log('\n🔑 DEFAULT LOGIN CREDENTIALS:');
  console.log('=============================');
  console.log('Super Admin: superadmin / SuperAdmin123!');
  console.log('Distribution Admin: dist_admin / DistAdmin123!');
  console.log('Transport Admin: transport_admin / TransAdmin123!');
  console.log('Warehouse Admin: warehouse_admin / WareAdmin123!');
  console.log('Sales Rep 1: sales_rep_1 / SalesRep123!');
  console.log('Sales Rep 2: sales_rep_2 / SalesRep123!');
  console.log('Warehouse Officer: warehouse_officer / WareOfficer123!');
  console.log('Cashier: cashier_1 / Cashier123!');
  console.log('Transport Staff: transport_staff / TransStaff123!');

  console.log('\n⚠️  IMPORTANT: Change all default passwords in production!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });