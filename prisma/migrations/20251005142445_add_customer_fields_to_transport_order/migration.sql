/*
  Warnings:

  - Added the required column `deliveryAddress` to the `transport_orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `transport_orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `phone` to the `transport_orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pickupLocation` to the `transport_orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."transport_orders" ADD COLUMN     "deliveryAddress" TEXT NOT NULL,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "phone" TEXT NOT NULL,
ADD COLUMN     "pickupLocation" TEXT NOT NULL;
