-- DropForeignKey
ALTER TABLE "public"."discount_approval_requests" DROP CONSTRAINT "discount_approval_requests_customer_fkey";

-- DropForeignKey
ALTER TABLE "public"."discount_approval_requests" DROP CONSTRAINT "discount_approval_requests_requested_by_fkey";

-- DropForeignKey
ALTER TABLE "public"."warehouse_customer_discounts" DROP CONSTRAINT "warehouse_customer_discounts_customer_fkey";

-- DropIndex
DROP INDEX "public"."discount_approval_requests_customer_idx";

-- DropIndex
DROP INDEX "public"."warehouse_customer_discounts_customer_idx";

-- DropIndex
DROP INDEX "public"."warehouse_sale_discounts_sale_idx";

-- CreateTable
CREATE TABLE "public"."warehouse_expenses" (
    "id" TEXT NOT NULL,
    "expense_type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "expense_date" TIMESTAMP(3) NOT NULL,
    "product_id" TEXT,
    "location" TEXT,
    "vendor_name" TEXT,
    "vendor_contact" TEXT,
    "receipt_number" TEXT,
    "receipt_url" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "payment_date" TIMESTAMP(3),
    "payment_method" "public"."PaymentMethod",
    "payment_reference" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_expenses_pkey" PRIMARY KEY ("id")
);

-- RenameForeignKey
ALTER TABLE "public"."discount_approval_requests" RENAME CONSTRAINT "discount_approval_requests_product_fkey" TO "discount_approval_requests_product_id_fkey";

-- RenameForeignKey
ALTER TABLE "public"."warehouse_customer_discounts" RENAME CONSTRAINT "warehouse_customer_discounts_product_fkey" TO "warehouse_customer_discounts_product_id_fkey";

-- RenameForeignKey
ALTER TABLE "public"."warehouse_sale_discounts" RENAME CONSTRAINT "warehouse_sale_discounts_customer_discount_fkey" TO "warehouse_sale_discounts_customer_discount_id_fkey";

-- RenameForeignKey
ALTER TABLE "public"."warehouse_sale_discounts" RENAME CONSTRAINT "warehouse_sale_discounts_sale_fkey" TO "warehouse_sale_discounts_warehouse_sale_id_fkey";

-- AddForeignKey
ALTER TABLE "public"."warehouse_expenses" ADD CONSTRAINT "warehouse_expenses_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_expenses" ADD CONSTRAINT "warehouse_expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_expenses" ADD CONSTRAINT "warehouse_expenses_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_customer_discounts" ADD CONSTRAINT "warehouse_customer_discounts_warehouse_customer_id_fkey" FOREIGN KEY ("warehouse_customer_id") REFERENCES "public"."warehouse_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."discount_approval_requests" ADD CONSTRAINT "discount_approval_requests_warehouse_customer_id_fkey" FOREIGN KEY ("warehouse_customer_id") REFERENCES "public"."warehouse_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."discount_approval_requests" ADD CONSTRAINT "discount_approval_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
