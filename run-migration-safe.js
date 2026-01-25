// Safe migration script that handles connection cleanup
const { PrismaClient } = require('@prisma/client');

async function runMigration() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    }
  });

  try {
    console.log('🔍 Checking if table already exists...');

    // Check if table exists
    const tableExists = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'supplier_products'
      );
    `;

    if (tableExists[0].exists) {
      console.log('✅ Table supplier_products already exists!');
      await prisma.$disconnect();
      process.exit(0);
    }

    console.log('📦 Creating supplier_products table...');

    // Create the table
    await prisma.$executeRaw`
      CREATE TABLE supplier_products (
        id TEXT NOT NULL PRIMARY KEY,
        supplier_company_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        supplier_cost_per_pack DECIMAL(10,2) NOT NULL,
        is_available BOOLEAN NOT NULL DEFAULT true,
        minimum_order_packs INTEGER,
        lead_time_days INTEGER,
        notes TEXT,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP(3) NOT NULL,

        CONSTRAINT supplier_products_supplier_company_id_fkey
          FOREIGN KEY (supplier_company_id)
          REFERENCES supplier_companies(id)
          ON DELETE CASCADE,

        CONSTRAINT supplier_products_product_id_fkey
          FOREIGN KEY (product_id)
          REFERENCES products(id)
          ON DELETE CASCADE
      )
    `;

    console.log('✅ Table created successfully');

    console.log('📇 Creating unique index...');

    await prisma.$executeRaw`
      CREATE UNIQUE INDEX supplier_products_supplier_company_id_product_id_key
      ON supplier_products(supplier_company_id, product_id)
    `;

    console.log('✅ Index created successfully');

    console.log('📇 Creating additional indexes for performance...');

    await prisma.$executeRaw`
      CREATE INDEX idx_supplier_products_supplier_id
      ON supplier_products(supplier_company_id)
    `;

    await prisma.$executeRaw`
      CREATE INDEX idx_supplier_products_product_id
      ON supplier_products(product_id)
    `;

    await prisma.$executeRaw`
      CREATE INDEX idx_supplier_products_is_available
      ON supplier_products(is_available)
    `;

    console.log('✅ All indexes created successfully');
    console.log('\n🎉 Migration completed successfully!');
    console.log('✅ You can now use the Supplier Products feature');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);

    if (error.message.includes('already exists')) {
      console.log('ℹ️  Table might already exist. Checking...');
    } else if (error.message.includes('too many clients')) {
      console.log('\n⚠️  Database has too many connections.');
      console.log('💡 Try again in a few seconds, or restart your backend server first.');
    }

    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run with proper error handling
runMigration().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
