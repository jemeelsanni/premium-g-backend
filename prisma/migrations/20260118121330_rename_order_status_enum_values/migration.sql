-- Migration: Rename OrderStatus enum values to be supplier-agnostic
-- SENT_TO_RITE_FOODS -> SENT_TO_SUPPLIER
-- PROCESSING_BY_RFL -> PROCESSING_BY_SUPPLIER

-- Step 1: Add new enum values
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'SENT_TO_SUPPLIER';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PROCESSING_BY_SUPPLIER';

-- Step 2: Update existing records to use new values
UPDATE "distribution_orders"
SET "status" = 'SENT_TO_SUPPLIER'
WHERE "status" = 'SENT_TO_RITE_FOODS';

UPDATE "distribution_orders"
SET "status" = 'PROCESSING_BY_SUPPLIER'
WHERE "status" = 'PROCESSING_BY_RFL';

-- Step 3: Create a new enum type without the old values
CREATE TYPE "OrderStatus_new" AS ENUM (
  'PENDING',
  'PAYMENT_CONFIRMED',
  'SENT_TO_SUPPLIER',
  'PROCESSING_BY_SUPPLIER',
  'LOADED',
  'IN_TRANSIT',
  'DELIVERED',
  'PARTIALLY_DELIVERED',
  'CANCELLED',
  'RETURNED'
);

-- Step 4: Alter the table to use the new enum
ALTER TABLE "distribution_orders"
  ALTER COLUMN "status" TYPE "OrderStatus_new"
  USING ("status"::text::"OrderStatus_new");

-- Step 5: Drop old enum and rename new one
DROP TYPE "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
