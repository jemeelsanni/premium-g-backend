/*
  Warnings:

  - A unique constraint covering the columns `[order_number]` on the table `distribution_orders` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."distribution_orders" ADD COLUMN     "order_number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "distribution_orders_order_number_key" ON "public"."distribution_orders"("order_number");
