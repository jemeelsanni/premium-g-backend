// ================================
// DELETE ALL USERS ONLY
// Bypasses FK constraints so other data (orders, expenses, etc.) is preserved
// ================================

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function deleteAllUsers() {
  console.log('🗑️  Starting user deletion...');

  try {
    // Disable FK constraint checks temporarily (PostgreSQL only)
    await prisma.$executeRawUnsafe(`SET session_replication_role = 'replica'`);

    // Delete sessions first (has cascade anyway, but be explicit)
    const deletedSessions = await prisma.userSession.deleteMany({});
    console.log(`✅ Deleted ${deletedSessions.count} user sessions`);

    // Delete all users
    const deletedUsers = await prisma.user.deleteMany({});
    console.log(`✅ Deleted ${deletedUsers.count} users`);

    // Re-enable FK constraint checks
    await prisma.$executeRawUnsafe(`SET session_replication_role = 'origin'`);

    console.log('\n🎉 Done! All users deleted. Other data (orders, expenses, etc.) is preserved.');
    console.log('👉 Next steps:');
    console.log('   1. Run: npx prisma migrate dev --name update_user_roles');
    console.log('   2. Run: node prisma/seed.js');

  } catch (error) {
    // Make sure FK checks are re-enabled even on error
    try {
      await prisma.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
    } catch (_) {}

    console.error('❌ Error during user deletion:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

deleteAllUsers()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
