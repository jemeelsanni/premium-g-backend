-- DropForeignKey
ALTER TABLE "public"."distribution_orders" DROP CONSTRAINT "distribution_orders_location_id_fkey";

-- AlterTable
ALTER TABLE "public"."distribution_orders" ADD COLUMN     "deliveryLocation" TEXT,
ALTER COLUMN "location_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."distribution_orders" ADD CONSTRAINT "distribution_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
