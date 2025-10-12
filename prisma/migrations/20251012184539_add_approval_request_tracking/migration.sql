-- AlterTable
ALTER TABLE "public"."warehouse_customer_discounts" ADD COLUMN     "approval_request_id" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "public"."warehouse_customer_discounts" ADD CONSTRAINT "warehouse_customer_discounts_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "public"."discount_approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
