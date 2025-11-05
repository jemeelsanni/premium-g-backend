// ================================
// MINIMAL SEED FILE - USERNAME & PASSWORD ONLY
// ================================

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting minimal seed with username and password only...');
  
  try {
    

    // ================================
    // STEP 2: Create users with ONLY username and password
    // ================================
    console.log('👥 Creating users with username and password...');

    const hashedPassword = await bcrypt.hash('password123', 10);

    const usersData = [
      {
        username: 'admin',
        email: 'admin@premiumg.com',
        passwordHash: hashedPassword,
        role: 'SUPER_ADMIN',
        isActive: true
      },
      {
        username: 'distribution_admin',
        email: 'distribution@premiumg.com',
        passwordHash: hashedPassword,
        role: 'DISTRIBUTION_ADMIN',
        isActive: true
      },
      {
        username: 'transport_admin',
        email: 'transport@premiumg.com',
        passwordHash: hashedPassword,
        role: 'TRANSPORT_ADMIN',
        isActive: true
      },
      {
        username: 'warehouse_admin',
        email: 'warehouse@premiumg.com',
        passwordHash: hashedPassword,
        role: 'WAREHOUSE_ADMIN',
        isActive: true
      },
      {
        username: 'sales_rep',
        email: 'salesrep@premiumg.com',
        passwordHash: hashedPassword,
        role: 'DISTRIBUTION_SALES_REP',
        isActive: true
      },
      {
        username: 'warehouse_sales',
        email: 'warehousesales@premiumg.com',
        passwordHash: hashedPassword,
        role: 'WAREHOUSE_SALES_OFFICER',
        isActive: true
      },
      {
        username: 'cashier',
        email: 'cashier@premiumg.com',
        passwordHash: hashedPassword,
        role: 'CASHIER',
        isActive: true
      },
      {
        username: 'transport_staff',
        email: 'transportstaff@premiumg.com',
        passwordHash: hashedPassword,
        role: 'TRANSPORT_STAFF',
        isActive: true
      }
    ];

    await prisma.user.createMany({ data: usersData });
    console.log(`✅ Created ${usersData.length} users`);

    // ================================
    // VERIFICATION
    // ================================
    console.log('\n🔍 Verifying seeded data...');

    const userCount = await prisma.user.count();

    console.log('\n📊 SEED VERIFICATION SUMMARY:');
    console.log('==============================');
    console.log(`✅ Users: ${userCount}`);

    console.log('\n🎉 MINIMAL SEED COMPLETED!');
    console.log('============================================================');
    console.log('✅ Database cleared and seeded with users only');
    console.log('🔐 All users password: "password123"');
    console.log('\n📝 Available users:');
    console.log('   - Username: admin              (Role: SUPER_ADMIN)');
    console.log('   - Username: distribution_admin (Role: DISTRIBUTION_ADMIN)');
    console.log('   - Username: transport_admin    (Role: TRANSPORT_ADMIN)');
    console.log('   - Username: warehouse_admin    (Role: WAREHOUSE_ADMIN)');
    console.log('   - Username: sales_rep          (Role: DISTRIBUTION_SALES_REP)');
    console.log('   - Username: warehouse_sales    (Role: WAREHOUSE_SALES_OFFICER)');
    console.log('   - Username: cashier            (Role: CASHIER)');
    console.log('   - Username: transport_staff    (Role: TRANSPORT_STAFF)');
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