-- Migration: Rename OrderStatus enum values to be supplier-agnostic
-- SENT_TO_RITE_FOODS -> SENT_TO_SUPPLIER
-- PROCESSING_BY_RFL -> PROCESSING_BY_SUPPLIER

-- Note: This migration only adds new enum values.
-- The actual data migration and cleanup will happen in subsequent migrations
-- to avoid PostgreSQL's enum transaction limitations.

-- Add new enum values (they can coexist with old ones temporarily)
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'SENT_TO_SUPPLIER';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PROCESSING_BY_SUPPLIER';
