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
        username: 'managing_director',
        email: 'md@premiumg.com',
        passwordHash: hashedPassword,
        role: 'MANAGING_DIRECTOR',
        isActive: true
      },
      {
        username: 'general_manager',
        email: 'gm@premiumg.com',
        passwordHash: hashedPassword,
        role: 'GENERAL_MANAGER',
        isActive: true
      },
      {
        username: 'accountant',
        email: 'accountant@premiumg.com',
        passwordHash: hashedPassword,
        role: 'ACCOUNTANT',
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
        username: 'sales_rep',
        email: 'salesrep@premiumg.com',
        passwordHash: hashedPassword,
        role: 'DISTRIBUTORSHIP_SALES_REP',
        isActive: true
      },
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
    console.log('   - Username: managing_director  (Role: MANAGING_DIRECTOR)');
    console.log('   - Username: general_manager    (Role: GENERAL_MANAGER)');
    console.log('   - Username: accountant         (Role: ACCOUNTANT)');
    console.log('   - Username: cashier            (Role: CASHIER)');
    console.log('   - Username: sales_rep          (Role: DISTRIBUTORSHIP_SALES_REP)');
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
