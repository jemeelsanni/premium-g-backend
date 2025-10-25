-- AlterTable
ALTER TABLE "public"."warehouse_product_purchases" ADD COLUMN     "batch_number" TEXT,
ADD COLUMN     "expiry_date" TIMESTAMP(3),
ADD COLUMN     "order_number" TEXT;
