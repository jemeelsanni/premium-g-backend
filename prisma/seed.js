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
      await prisma.kPIMetrics.deleteMany();
      await prisma.profitAnalysis.deleteMany();
      await prisma.expense.deleteMany();
      await prisma.auditLog.deleteMany();
      await prisma.userSession.deleteMany();
      await prisma.priceAdjustment.deleteMany();
      await prisma.distributionOrderItem.deleteMany();
      await prisma.distributionOrder.deleteMany();
      await prisma.transportOrder.deleteMany();
      await prisma.warehouseSale.deleteMany();
      await prisma.cashFlow.deleteMany();
      await prisma.warehouseInventory.deleteMany();
      await prisma.palletPricing.deleteMany();
      await prisma.truckCapacity.deleteMany();
      await prisma.weeklyPerformance.deleteMany();
      await prisma.distributionTarget.deleteMany();
      await prisma.product.deleteMany();
      await prisma.customer.deleteMany();
      await prisma.location.deleteMany();
      await prisma.user.deleteMany();
      await prisma.systemConfig.deleteMany();
      
      console.log('✅ Existing data cleared');
    } catch (error) {
      console.log('⚠️ Some tables might not exist yet, continuing...');
    }
  }

  // ================================
  // CREATE SYSTEM CONFIGURATIONS
  // ================================

  console.log('⚙️ Creating system configurations...');

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
      key: 'DEFAULT_FUEL_PRICE',
      value: 850.00,
      description: 'Default fuel price per liter (Naira)',
      updatedBy: systemUserId
    },
    {
      key: 'COMPANY_SETTINGS',
      value: {
        name: 'Premium G Enterprise',
        address: 'Lagos, Nigeria',
        phone: '+234-xxx-xxxx',
        email: 'info@premiumg.com',
        taxId: 'TIN-XXXXXXXX'
      },
      description: 'Company information settings',
      updatedBy: systemUserId
    }
  ];

  for (const config of configs) {
    await prisma.systemConfig.create({ data: config });
  }

  console.log(`✅ Created ${configs.length} system configurations`);

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
      email: 'cashier1@premiumg.com',
      password: 'Cashier123!',
      role: 'CASHIER'
    },
    {
      username: 'cashier_2',
      email: 'cashier2@premiumg.com',
      password: 'Cashier123!',
      role: 'CASHIER'
    },
    {
      username: 'transport_staff_1',
      email: 'transport1@premiumg.com',
      password: 'TransStaff123!',
      role: 'TRANSPORT_STAFF'
    },
    {
      username: 'transport_staff_2',
      email: 'transport2@premiumg.com',
      password: 'TransStaff123!',
      role: 'TRANSPORT_STAFF'
    }
  ];

  const createdUsers = {};

  for (const userData of users) {
    const hashedPassword = await bcrypt.hash(userData.password, saltRounds);
    const user = await prisma.user.create({
      data: {
        username: userData.username,
        email: userData.email,
        passwordHash: hashedPassword,
        role: userData.role
      }
    });
    createdUsers[userData.username] = user;
    console.log(`✅ Created user: ${userData.username} (${userData.role})`);
  }

  // ================================
  // CREATE LOCATIONS
  // ================================

  console.log('📍 Creating locations...');

  const locations = [
    {
      name: 'Lagos Central',
      address: 'Central Business District, Lagos',
      fuelAdjustment: 0,
      driverWagesPerTrip: 5000.00,
      deliveryNotes: 'City center - Heavy traffic expected during rush hours'
    },
    {
      name: 'Ikeja',
      address: 'Ikeja Industrial Area, Lagos',
      fuelAdjustment: 2.50,
      driverWagesPerTrip: 6000.00,
      deliveryNotes: 'Industrial zone - Allow extra time for loading'
    },
    {
      name: 'Victoria Island',
      address: 'Victoria Island, Lagos',
      fuelAdjustment: 1.50,
      driverWagesPerTrip: 7000.00,
      deliveryNotes: 'Premium location - Professional delivery required'
    },
    {
      name: 'Lekki',
      address: 'Lekki Phase 1, Lagos',
      fuelAdjustment: 3.00,
      driverWagesPerTrip: 7500.00,
      deliveryNotes: 'Residential area - Coordinate delivery time with customer'
    },
    {
      name: 'Surulere',
      address: 'Surulere, Lagos',
      fuelAdjustment: 1.00,
      driverWagesPerTrip: 5500.00,
      deliveryNotes: 'Mixed commercial/residential area'
    },
    {
      name: 'Ikorodu',
      address: 'Ikorodu, Lagos',
      fuelAdjustment: 5.00,
      driverWagesPerTrip: 9000.00,
      deliveryNotes: 'Long distance - Requires full tank and early departure'
    }
  ];

  const createdLocations = {};

  for (const locationData of locations) {
    const location = await prisma.location.create({ data: locationData });
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
      address: 'Plot 45, Commercial Avenue, Ikeja'
    },
    {
      name: 'XYZ Trading Company',
      email: 'purchasing@xyztrading.com',
      phone: '+234-802-345-6789',
      address: 'Suite 12, Business Complex, Victoria Island'
    },
    {
      name: 'QuickMart Stores',
      email: 'supply@quickmart.ng',
      phone: '+234-803-456-7890',
      address: '78 Shopping Street, Lekki'
    },
    {
      name: 'MegaStore Nigeria',
      email: 'procurement@megastore.ng',
      phone: '+234-804-567-8901',
      address: 'Block A, Retail Park, Surulere'
    },
    {
      name: 'Fresh Foods Limited',
      email: 'orders@freshfoods.com',
      phone: '+234-805-678-9012',
      address: 'Industrial Estate, Ikorodu'
    },
    {
      name: 'Downtown Mart',
      email: 'supplies@downtownmart.ng',
      phone: '+234-806-789-0123',
      address: '23 Market Road, Lagos Central'
    }
  ];

  const createdCustomers = {};

  for (const customerData of customers) {
    const customer = await prisma.customer.create({ data: customerData });
    createdCustomers[customerData.name] = customer;
    console.log(`✅ Created customer: ${customerData.name}`);
  }

  // ================================
  // CREATE PRODUCTS
  // ================================

  console.log('📦 Creating products...');

  const products = [
    {
      productNo: 'RF001',
      name: 'Premium Rice 50kg',
      description: 'High quality long grain rice - 50kg bag',
      packsPerPallet: 20,
      pricePerPack: 250.00,
      costPerPack: 180.00
    },
    {
      productNo: 'RF002',
      name: 'Premium Rice 25kg',
      description: 'High quality long grain rice - 25kg bag',
      packsPerPallet: 40,
      pricePerPack: 130.00,
      costPerPack: 95.00
    },
    {
      productNo: 'RF003',
      name: 'Standard Rice 50kg',
      description: 'Standard quality rice - 50kg bag',
      packsPerPallet: 20,
      pricePerPack: 220.00,
      costPerPack: 160.00
    },
    {
      productNo: 'RF004',
      name: 'Premium Beans 5kg',
      description: 'Premium quality beans - 5kg pack',
      packsPerPallet: 100,
      pricePerPack: 120.00,
      costPerPack: 85.00
    },
    {
      productNo: 'RF005',
      name: 'Premium Garri 10kg',
      description: 'Premium quality garri - 10kg bag',
      packsPerPallet: 60,
      pricePerPack: 80.00,
      costPerPack: 55.00
    },
    {
      productNo: 'RF006',
      name: 'Premium Flour 50kg',
      description: 'Premium wheat flour - 50kg bag',
      packsPerPallet: 25,
      pricePerPack: 280.00,
      costPerPack: 200.00
    }
  ];

  const createdProducts = {};

  for (const productData of products) {
    const product = await prisma.product.create({ data: productData });
    createdProducts[productData.productNo] = product;
    console.log(`✅ Created product: ${productData.productNo} - ${productData.name}`);
  }

  // ================================
  // CREATE PALLET PRICING
  // ================================

  console.log('💰 Creating pallet pricing...');

  for (const [productNo, product] of Object.entries(createdProducts)) {
    for (const [locationName, location] of Object.entries(createdLocations)) {
      const basePrice = product.pricePerPack;
      const fuelAdjustment = location.fuelAdjustment;
      const adjustedPrice = parseFloat(basePrice) + parseFloat(fuelAdjustment);

      await prisma.palletPricing.create({
        data: {
          productId: product.id,
          locationId: location.id,
          pricePerPack: adjustedPrice,
          fuelAdjustment: fuelAdjustment
        }
      });
    }
  }

  console.log('✅ Created pallet pricing for all product-location combinations');

  // ================================
  // CREATE TRUCK CAPACITY RECORDS
  // ================================

  console.log('🚚 Creating truck capacity records...');

  const trucks = [
    { truckId: 'PG-001', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-002', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-003', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-004', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-005', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-006', maxPallets: 12, currentLoad: 0 },
    { truckId: 'PG-007', maxPallets: 10, currentLoad: 0 }, // Smaller truck
    { truckId: 'PG-008', maxPallets: 10, currentLoad: 0 }  // Smaller truck
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
        packs: Math.floor(Math.random() * 300) + 100,  // 100-399 packs
        units: Math.floor(Math.random() * 800) + 200,  // 200-999 units
        reorderLevel: 50,
        maxStockLevel: 800,
        location: 'Main Warehouse'
      }
    });
  }

  console.log(`✅ Created inventory for ${Object.keys(createdProducts).length} products`);

  // ================================
  // CREATE DISTRIBUTION TARGETS
  // ================================

  console.log('🎯 Creating distribution targets...');

  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  const distributionTarget = await prisma.distributionTarget.create({
    data: {
      year: currentYear,
      month: currentMonth,
      totalPacksTarget: 140000,
      weeklyTargets: [35000, 35000, 35000, 35000]
    }
  });

  // Create weekly performance records
  const weekStartDates = [
    new Date(currentYear, currentMonth - 1, 1),
    new Date(currentYear, currentMonth - 1, 8),
    new Date(currentYear, currentMonth - 1, 15),
    new Date(currentYear, currentMonth - 1, 22)
  ];

  for (let i = 0; i < 4; i++) {
    await prisma.weeklyPerformance.create({
      data: {
        targetId: distributionTarget.id,
        weekNumber: i + 1,
        targetPacks: 35000,
        actualPacks: Math.floor(Math.random() * 15000) + 25000, // 25k-40k
        percentageAchieved: 0, // Will be calculated
        weekStartDate: weekStartDates[i],
        weekEndDate: new Date(weekStartDates[i].getTime() + 6 * 24 * 60 * 60 * 1000)
      }
    });
  }

  console.log('✅ Created distribution targets and weekly performance records');

  // ================================
  // CREATE SAMPLE DISTRIBUTION ORDERS
  // ================================

  console.log('📋 Creating sample distribution orders...');

  const sampleOrders = [
    {
      customerId: createdCustomers['ABC Supermarket Ltd'].id,
      locationId: createdLocations['Ikeja'].id,
      createdBy: createdUsers['sales_rep_1'].id,
      status: 'DELIVERED',
      transporterCompany: 'Premium G Transport',
      driverNumber: 'DRV001',
      remark: 'Regular weekly order - Priority customer',
      orderItems: [
        {
          productId: createdProducts['RF001'].id,
          pallets: 3,
          packs: 60,
          amount: 15000.00
        },
        {
          productId: createdProducts['RF004'].id,
          pallets: 2,
          packs: 200,
          amount: 24000.00
        }
      ]
    },
    {
      customerId: createdCustomers['XYZ Trading Company'].id,
      locationId: createdLocations['Victoria Island'].id,
      createdBy: createdUsers['sales_rep_2'].id,
      status: 'IN_TRANSIT',
      transporterCompany: 'Premium G Transport',
      driverNumber: 'DRV002',
      remark: 'Express delivery requested',
      orderItems: [
        {
          productId: createdProducts['RF002'].id,
          pallets: 4,
          packs: 160,
          amount: 20800.00
        },
        {
          productId: createdProducts['RF006'].id,
          pallets: 2,
          packs: 50,
          amount: 14000.00
        }
      ]
    },
    {
      customerId: createdCustomers['QuickMart Stores'].id,
      locationId: createdLocations['Lekki'].id,
      createdBy: createdUsers['sales_rep_1'].id,
      status: 'CONFIRMED',
      transporterCompany: 'Premium G Transport',
      driverNumber: 'DRV003',
      remark: 'New customer - First order',
      orderItems: [
        {
          productId: createdProducts['RF003'].id,
          pallets: 5,
          packs: 100,
          amount: 22000.00
        }
      ]
    }
  ];

  const createdOrders = [];

  for (const orderData of sampleOrders) {
    const { orderItems, ...orderInfo } = orderData;
    
    const totalPallets = orderItems.reduce((sum, item) => sum + item.pallets, 0);
    const totalPacks = orderItems.reduce((sum, item) => sum + item.packs, 0);
    const totalAmount = orderItems.reduce((sum, item) => sum + parseFloat(item.amount), 0);

    const order = await prisma.distributionOrder.create({
      data: {
        ...orderInfo,
        totalPallets,
        totalPacks,
        originalAmount: totalAmount,
        finalAmount: totalAmount,
        balance: 0
      }
    });

    for (const item of orderItems) {
      await prisma.distributionOrderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          pallets: item.pallets,
          packs: item.packs,
          amount: item.amount
        }
      });
    }

    createdOrders.push(order);
    console.log(`✅ Created distribution order for ${orderInfo.customerId}`);
  }

  // ================================
  // CREATE TRANSPORT ORDERS
  // ================================

  console.log('🚛 Creating transport orders...');

  for (const order of createdOrders.slice(0, 2)) { // First 2 orders
    const location = createdLocations['Ikeja']; // Get the actual location
    const fuelRequired = 45.00;
    const fuelPrice = 850.00;
    const totalFuelCost = fuelRequired * fuelPrice;
    const serviceCharge = parseFloat(order.finalAmount) * 0.10;
    const driverWages = location.driverWagesPerTrip;
    const totalExpenses = totalFuelCost + serviceCharge + driverWages;
    const grossProfit = parseFloat(order.finalAmount) - totalExpenses;
    const profitMarginPercent = (grossProfit / parseFloat(order.finalAmount)) * 100;
    
    await prisma.transportOrder.create({
      data: {
        distributionOrderId: order.id,
        orderNumber: `TO-2025-${String(createdOrders.indexOf(order) + 1).padStart(4, '0')}`,
        invoiceNumber: `INV-2025-${String(createdOrders.indexOf(order) + 1).padStart(4, '0')}`,
        locationId: order.locationId,
        truckId: Object.values(createdTrucks)[createdOrders.indexOf(order)].truckId,
        totalOrderAmount: order.finalAmount,
        fuelRequired,
        fuelPricePerLiter: fuelPrice,
        totalFuelCost,
        serviceChargeExpense: serviceCharge,
        driverWages,
        truckExpenses: 0,
        totalExpenses,
        grossProfit,
        netProfit: grossProfit,
        profitMargin: Math.min(Math.max(profitMarginPercent, -999.99), 999.99), // Clamp to valid range
        deliveryStatus: order.status === 'DELIVERED' ? 'DELIVERED' : 'IN_TRANSIT',
        deliveryDate: order.status === 'DELIVERED' ? new Date() : null,
        createdBy: order.createdBy
      }
    });
  }

  console.log(`✅ Created transport orders`);

  // ================================
  // CREATE WAREHOUSE SALES
  // ================================

  console.log('🏪 Creating warehouse sales...');

  const warehouseSales = [
    {
      productId: createdProducts['RF001'].id,
      quantity: 10,
      unitType: 'PACKS',
      unitPrice: 250.00,
      costPerUnit: 180.00, // Cost from product
      paymentMethod: 'CASH',
      customerName: 'Walk-in Customer 1',
      customerPhone: '+234-901-111-1111',
      receiptNumber: 'WH-2025-001',
      salesOfficer: createdUsers['warehouse_officer'].id
    },
    {
      productId: createdProducts['RF004'].id,
      quantity: 50,
      unitType: 'UNITS',
      unitPrice: 120.00,
      costPerUnit: 85.00, // Cost from product
      paymentMethod: 'BANK_TRANSFER',
      customerName: 'Local Retailer ABC',
      customerPhone: '+234-902-222-2222',
      receiptNumber: 'WH-2025-002',
      salesOfficer: createdUsers['warehouse_officer'].id
    },
    {
      productId: createdProducts['RF005'].id,
      quantity: 25,
      unitType: 'PACKS',
      unitPrice: 80.00,
      costPerUnit: 55.00, // Cost from product
      paymentMethod: 'CARD', // Changed from POS to CARD
      customerName: 'Walk-in Customer 2',
      receiptNumber: 'WH-2025-003',
      salesOfficer: createdUsers['warehouse_officer'].id
    }
  ];

  for (const saleData of warehouseSales) {
    const totalAmount = saleData.quantity * saleData.unitPrice;
    const totalCost = saleData.quantity * saleData.costPerUnit;
    const grossProfit = totalAmount - totalCost;
    const profitMargin = totalAmount > 0 ? (grossProfit / totalAmount) * 100 : 0;
    
    await prisma.warehouseSale.create({
      data: {
        ...saleData,
        totalAmount,
        totalCost,
        grossProfit,
        profitMargin: Math.min(Math.max(profitMargin, -999.99), 999.99) // Clamp to valid range
      }
    });
  }

  console.log(`✅ Created ${warehouseSales.length} warehouse sales`);

  // ================================
  // CREATE CASH FLOW ENTRIES
  // ================================

  console.log('💰 Creating cash flow entries...');

  const cashFlowEntries = [
    {
      transactionType: 'CASH_IN',
      amount: 2500.00,
      paymentMethod: 'CASH',
      description: 'Warehouse sale - Receipt WH-2025-001',
      referenceNumber: 'WH-2025-001',
      cashier: createdUsers['cashier_1'].id
    },
    {
      transactionType: 'CASH_IN',
      amount: 6000.00,
      paymentMethod: 'BANK_TRANSFER',
      description: 'Warehouse sale - Receipt WH-2025-002',
      referenceNumber: 'WH-2025-002',
      cashier: createdUsers['cashier_1'].id
    },
    {
      transactionType: 'CASH_IN',
      amount: 2000.00,
      paymentMethod: 'CARD', // Changed from POS to CARD
      description: 'Warehouse sale - Receipt WH-2025-003',
      referenceNumber: 'WH-2025-003',
      cashier: createdUsers['cashier_2'].id
    },
    {
      transactionType: 'CASH_OUT',
      amount: 1500.00,
      paymentMethod: 'CASH',
      description: 'Office supplies purchase',
      cashier: createdUsers['cashier_1'].id
    },
    {
      transactionType: 'CASH_OUT',
      amount: 5000.00,
      paymentMethod: 'BANK_TRANSFER',
      description: 'Utility bills payment',
      referenceNumber: 'UTIL-2025-001',
      cashier: createdUsers['cashier_2'].id
    }
  ];

  for (const cashFlow of cashFlowEntries) {
    await prisma.cashFlow.create({ data: cashFlow });
  }

  console.log(`✅ Created ${cashFlowEntries.length} cash flow entries`);

  // ================================
  // CREATE EXPENSES
  // ================================

  console.log('💸 Creating expense records...');

  const expenses = [
    {
      expenseType: 'FUEL_COST',
      category: 'FUEL',
      amount: 38250.00,
      description: 'Fuel purchase for truck PG-001',
      referenceId: createdTrucks['PG-001'].truckId,
      expenseDate: new Date(),
      truckId: createdTrucks['PG-001'].truckId,
      status: 'APPROVED',
      approvedBy: createdUsers['transport_admin'].id,
      approvedAt: new Date(),
      createdBy: createdUsers['transport_staff_1'].id
    },
    {
      expenseType: 'TRUCK_EXPENSE',
      category: 'MAINTENANCE',
      amount: 25000.00,
      description: 'Routine maintenance - Truck PG-002',
      referenceId: createdTrucks['PG-002'].truckId,
      expenseDate: new Date(),
      truckId: createdTrucks['PG-002'].truckId,
      status: 'PENDING',
      createdBy: createdUsers['transport_staff_2'].id,
      receiptNumber: 'MAINT-2025-001'
    },
    {
      expenseType: 'OPERATIONAL',
      category: 'DRIVER_WAGES',
      amount: 50000.00,
      description: 'Weekly driver wages payment',
      expenseDate: new Date(),
      status: 'APPROVED',
      approvedBy: createdUsers['transport_admin'].id,
      approvedAt: new Date(),
      createdBy: createdUsers['transport_admin'].id
    },
    {
      expenseType: 'WAREHOUSE_EXPENSE',
      category: 'OFFICE_SUPPLIES',
      amount: 15000.00,
      description: 'Office supplies and stationery',
      expenseDate: new Date(),
      status: 'APPROVED',
      approvedBy: createdUsers['warehouse_admin'].id,
      approvedAt: new Date(),
      createdBy: createdUsers['warehouse_officer'].id
    },
    {
      expenseType: 'DISTRIBUTION_EXPENSE',
      category: 'MARKETING',
      amount: 30000.00,
      description: 'Marketing materials for distribution team',
      expenseDate: new Date(),
      status: 'PENDING',
      createdBy: createdUsers['dist_admin'].id
    }
  ];

  for (const expense of expenses) {
    await prisma.expense.create({ data: expense });
  }

  console.log(`✅ Created ${expenses.length} expense records`);

  // ================================
  // FINAL SUMMARY
  // ================================

  console.log('\n🎉 Database seeding completed successfully!');
  console.log('\n📊 SEEDING SUMMARY:');
  console.log('===================');
  console.log(`⚙️  System Configs: ${configs.length}`);
  console.log(`👥 Users: ${users.length}`);
  console.log(`📍 Locations: ${locations.length}`);
  console.log(`🏢 Customers: ${customers.length}`);
  console.log(`📦 Products: ${products.length}`);
  console.log(`🚚 Trucks: ${trucks.length}`);
  console.log(`🎯 Distribution Targets: 1 (with 4 weekly performance records)`);
  console.log(`📋 Distribution Orders: ${createdOrders.length}`);
  console.log(`🚛 Transport Orders: 2`);
  console.log(`🏪 Warehouse Sales: ${warehouseSales.length}`);
  console.log(`💰 Cash Flow Entries: ${cashFlowEntries.length}`);
  console.log(`💸 Expenses: ${expenses.length}`);
  console.log(`📦 Warehouse Inventory: ${Object.keys(createdProducts).length} products`);

  console.log('\n🔑 DEFAULT LOGIN CREDENTIALS:');
  console.log('=============================');
  console.log('Super Admin:');
  console.log('  Username: superadmin');
  console.log('  Password: SuperAdmin123!');
  console.log('');
  console.log('Distribution Admin:');
  console.log('  Username: dist_admin');
  console.log('  Password: DistAdmin123!');
  console.log('');
  console.log('Transport Admin:');
  console.log('  Username: transport_admin');
  console.log('  Password: TransAdmin123!');
  console.log('');
  console.log('Warehouse Admin:');
  console.log('  Username: warehouse_admin');
  console.log('  Password: WareAdmin123!');
  console.log('');
  console.log('Sales Representative:');
  console.log('  Username: sales_rep_1');
  console.log('  Password: SalesRep123!');
  console.log('');
  console.log('Warehouse Officer:');
  console.log('  Username: warehouse_officer');
  console.log('  Password: WareOfficer123!');
  console.log('');
  console.log('Cashier:');
  console.log('  Username: cashier_1');
  console.log('  Password: Cashier123!');
  console.log('');
  console.log('Transport Staff:');
  console.log('  Username: transport_staff_1');
  console.log('  Password: TransStaff123!');
  
  console.log('\n📝 NOTES:');
  console.log('=========');
  console.log('✓ All passwords follow the pattern: [Role]123!');
  console.log('✓ Sample data includes realistic business scenarios');
  console.log('✓ Inventory levels are randomized but within reasonable ranges');
  console.log('✓ Distribution targets set to 140,000 packs/month (35k/week)');
  console.log('✓ Pricing includes location-based fuel adjustments');
  console.log('✓ Transport orders include profit calculations');
  console.log('✓ Expense records demonstrate approval workflow');
  console.log('');
  console.log('🚀 Ready to run: npm run seed');
  console.log('🌐 Then start server: npm run dev');
}

main()
  .catch((error) => {
    console.error('❌ Error during seeding:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });