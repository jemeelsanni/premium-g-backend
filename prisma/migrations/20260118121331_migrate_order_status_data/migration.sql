-- Migration: Migrate existing data to use new OrderStatus enum values
-- This runs in a separate migration to ensure the enum values are committed first

-- Update existing records to use new values
UPDATE "distribution_orders"
SET "status" = 'SENT_TO_SUPPLIER'
WHERE "status" = 'SENT_TO_RITE_FOODS';

UPDATE "distribution_orders"
SET "status" = 'PROCESSING_BY_SUPPLIER'
WHERE "status" = 'PROCESSING_BY_RFL';
