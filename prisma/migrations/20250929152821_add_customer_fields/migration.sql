-- AlterTable
ALTER TABLE "public"."customers" ADD COLUMN     "customer_type" TEXT,
ADD COLUMN     "territory" TEXT,
ADD COLUMN     "total_orders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_spent" DECIMAL(15,2) NOT NULL DEFAULT 0;
