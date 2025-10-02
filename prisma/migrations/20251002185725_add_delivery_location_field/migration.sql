/*
  Warnings:

  - You are about to drop the column `deliveryLocation` on the `distribution_orders` table. All the data in the column will be lost.
  - Made the column `location_id` on table `distribution_orders` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "public"."distribution_orders" DROP CONSTRAINT "distribution_orders_location_id_fkey";

-- AlterTable
ALTER TABLE "public"."distribution_orders" DROP COLUMN "deliveryLocation",
ADD COLUMN     "delivery_location" TEXT,
ALTER COLUMN "location_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."distribution_orders" ADD CONSTRAINT "distribution_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
