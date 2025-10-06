/*
  Warnings:

  - Added the required column `total_trip_expenses` to the `transport_orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."transport_orders" ADD COLUMN     "total_trip_expenses" DECIMAL(12,2) NOT NULL;
