/*
  Warnings:

  - The values [SENT_TO_RITE_FOODS,PROCESSING_BY_RFL] on the enum `OrderStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."OrderStatus_new" AS ENUM ('PENDING', 'PAYMENT_CONFIRMED', 'SENT_TO_SUPPLIER', 'PROCESSING_BY_SUPPLIER', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED', 'RETURNED');
ALTER TABLE "public"."distribution_orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."transport_orders" ALTER COLUMN "delivery_status" DROP DEFAULT;
ALTER TABLE "public"."distribution_orders" ALTER COLUMN "status" TYPE "public"."OrderStatus_new" USING ("status"::text::"public"."OrderStatus_new");
ALTER TABLE "public"."transport_orders" ALTER COLUMN "delivery_status" TYPE "public"."OrderStatus_new" USING ("delivery_status"::text::"public"."OrderStatus_new");
ALTER TYPE "public"."OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "public"."OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "public"."OrderStatus_old";
ALTER TABLE "public"."distribution_orders" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "public"."transport_orders" ALTER COLUMN "delivery_status" SET DEFAULT 'PENDING';
COMMIT;

-- DropIndex
DROP INDEX "public"."idx_supplier_products_is_available";

-- DropIndex
DROP INDEX "public"."idx_supplier_products_product_id";

-- DropIndex
DROP INDEX "public"."idx_supplier_products_supplier_id";
