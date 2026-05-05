// ================================
// UPDATE UserRole ENUM IN DATABASE
// Replaces old roles with 5 new roles via raw SQL
// Safe to run because users table is already empty
// ================================

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function updateUserRoleEnum() {
  console.log('🔄 Updating UserRole enum in database...');

  try {
    // Step 1: Create the new enum type with the 5 new roles
    await prisma.$executeRawUnsafe(`
      CREATE TYPE "UserRole_new" AS ENUM (
        'MANAGING_DIRECTOR',
        'GENERAL_MANAGER',
        'ACCOUNTANT',
        'CASHIER',
        'DISTRIBUTORSHIP_SALES_REP'
      )
    `);
    console.log('✅ Created new UserRole enum type');

    // Step 2: Switch the column to use the new enum
    // (users table is empty so no casting issues)
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users
        ALTER COLUMN role TYPE "UserRole_new"
        USING role::text::"UserRole_new"
    `);
    console.log('✅ Updated users.role column to new enum');

    // Step 3: Drop the old enum
    await prisma.$executeRawUnsafe(`DROP TYPE "UserRole"`);
    console.log('✅ Dropped old UserRole enum');

    // Step 4: Rename new enum to the original name
    await prisma.$executeRawUnsafe(`ALTER TYPE "UserRole_new" RENAME TO "UserRole"`);
    console.log('✅ Renamed new enum to UserRole');

    console.log('\n🎉 UserRole enum updated successfully!');
    console.log('👉 Next step: node prisma/seed.js');

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

updateUserRoleEnum()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
