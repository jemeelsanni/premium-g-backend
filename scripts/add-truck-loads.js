/**
 * Migration: Add TruckLoad table and link to distribution_orders
 * Run with: node scripts/add-truck-loads.js
 */
require('../load-env');
const prisma = require('../lib/prisma');

async function main() {
  console.log('🚛 Adding truck_loads table...');

  // 1. Create the TruckLoadStatus enum
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "TruckLoadStatus" AS ENUM ('PLANNED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  console.log('✅ TruckLoadStatus enum ready');

  // 2. Create the truck_loads table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS truck_loads (
      id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      load_number         TEXT UNIQUE NOT NULL,
      supplier_company_id TEXT NOT NULL REFERENCES supplier_companies(id),
      status              "TruckLoadStatus" NOT NULL DEFAULT 'PLANNED',
      total_pallets       INTEGER NOT NULL DEFAULT 0,
      transporter_company TEXT,
      driver_number       TEXT,
      truck_number        TEXT,
      notes               TEXT,
      created_by          TEXT NOT NULL REFERENCES users(id),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('✅ truck_loads table created');

  // 3. Add truck_load_id column to distribution_orders
  await prisma.$executeRawUnsafe(`
    ALTER TABLE distribution_orders
    ADD COLUMN IF NOT EXISTS truck_load_id TEXT REFERENCES truck_loads(id);
  `);
  console.log('✅ truck_load_id column added to distribution_orders');

  console.log('🎉 Migration complete. Run: npx prisma generate');
}

main()
  .catch((e) => { console.error('❌ Migration failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
