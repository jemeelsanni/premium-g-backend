/*
  Warnings:

  - Added the required column `quantity_remaining` to the `warehouse_product_purchases` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."BatchStatus" AS ENUM ('ACTIVE', 'DEPLETED', 'EXPIRED');

-- AlterTable
ALTER TABLE "public"."warehouse_product_purchases" ADD COLUMN     "batch_status" "public"."BatchStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "quantity_remaining" INTEGER NOT NULL,
ADD COLUMN     "quantity_sold" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."warehouse_batch_sales" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "quantity_sold" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_batch_sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_batch_sales_sale_id_idx" ON "public"."warehouse_batch_sales"("sale_id");

-- CreateIndex
CREATE INDEX "warehouse_batch_sales_batch_id_idx" ON "public"."warehouse_batch_sales"("batch_id");

-- CreateIndex
CREATE INDEX "warehouse_product_purchases_batch_status_idx" ON "public"."warehouse_product_purchases"("batch_status");

-- CreateIndex
CREATE INDEX "warehouse_product_purchases_expiry_date_batch_status_idx" ON "public"."warehouse_product_purchases"("expiry_date", "batch_status");

-- CreateIndex
CREATE INDEX "warehouse_product_purchases_product_id_batch_status_expiry__idx" ON "public"."warehouse_product_purchases"("product_id", "batch_status", "expiry_date");

-- AddForeignKey
ALTER TABLE "public"."warehouse_batch_sales" ADD CONSTRAINT "warehouse_batch_sales_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."warehouse_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_batch_sales" ADD CONSTRAINT "warehouse_batch_sales_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."warehouse_product_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
