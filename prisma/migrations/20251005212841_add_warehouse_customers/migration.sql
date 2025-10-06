-- Add warehouse customers table
CREATE TABLE "public"."warehouse_customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "customer_type" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "business_name" TEXT,
    "preferred_payment_method" "public"."PaymentMethod",
    "credit_limit" DECIMAL(12,2),
    "total_purchases" INTEGER NOT NULL DEFAULT 0,
    "total_spent" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "average_order_value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "last_purchase_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "warehouse_customers_pkey" PRIMARY KEY ("id")
);

-- Optional reference to users
ALTER TABLE "public"."warehouse_customers"
    ADD CONSTRAINT "warehouse_customers_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Link warehouse sales to warehouse customers
ALTER TABLE "public"."warehouse_sales"
    ADD COLUMN "warehouse_customer_id" TEXT;

ALTER TABLE "public"."warehouse_sales"
    ADD COLUMN "original_unit_price" DECIMAL(10,2);

ALTER TABLE "public"."warehouse_sales"
    ADD COLUMN "discount_applied" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "public"."warehouse_sales"
    ADD COLUMN "total_discount_amount" DECIMAL(12,2);

ALTER TABLE "public"."warehouse_sales"
    ADD COLUMN "discount_percentage" DECIMAL(5,2);

ALTER TABLE "public"."warehouse_sales"
    ADD COLUMN "discount_reason" TEXT;

ALTER TABLE "public"."warehouse_sales"
    ADD COLUMN "approved_by" TEXT;

ALTER TABLE "public"."warehouse_sales"
    ADD CONSTRAINT "warehouse_sales_warehouse_customer_id_fkey"
    FOREIGN KEY ("warehouse_customer_id") REFERENCES "public"."warehouse_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."warehouse_sales"
    ADD CONSTRAINT "warehouse_sales_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Create warehouse customer discounts table
CREATE TABLE "public"."warehouse_customer_discounts" (
    "id" TEXT NOT NULL,
    "warehouse_customer_id" TEXT NOT NULL,
    "product_id" TEXT,
    "discount_type" TEXT NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "minimum_quantity" INTEGER,
    "maximum_discount_amount" DECIMAL(10,2),
    "usage_limit" INTEGER,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "total_discount_given" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3),
    "reason" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "requested_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "warehouse_customer_discounts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."warehouse_customer_discounts"
    ADD CONSTRAINT "warehouse_customer_discounts_customer_fkey"
    FOREIGN KEY ("warehouse_customer_id") REFERENCES "public"."warehouse_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."warehouse_customer_discounts"
    ADD CONSTRAINT "warehouse_customer_discounts_product_fkey"
    FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."warehouse_customer_discounts"
    ADD CONSTRAINT "warehouse_customer_discounts_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."warehouse_customer_discounts"
    ADD CONSTRAINT "warehouse_customer_discounts_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Track discounts applied to individual sales
CREATE TABLE "public"."warehouse_sale_discounts" (
    "id" TEXT NOT NULL,
    "warehouse_sale_id" TEXT NOT NULL,
    "customer_discount_id" TEXT,
    "original_unit_price" DECIMAL(10,2),
    "discounted_unit_price" DECIMAL(10,2),
    "discount_amount_per_unit" DECIMAL(10,2) NOT NULL,
    "total_discount_amount" DECIMAL(12,2) NOT NULL,
    "quantity_applied" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "warehouse_sale_discounts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."warehouse_sale_discounts"
    ADD CONSTRAINT "warehouse_sale_discounts_sale_fkey"
    FOREIGN KEY ("warehouse_sale_id") REFERENCES "public"."warehouse_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."warehouse_sale_discounts"
    ADD CONSTRAINT "warehouse_sale_discounts_customer_discount_fkey"
    FOREIGN KEY ("customer_discount_id") REFERENCES "public"."warehouse_customer_discounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Discount approval requests
CREATE TABLE "public"."discount_approval_requests" (
    "id" TEXT NOT NULL,
    "warehouse_customer_id" TEXT NOT NULL,
    "product_id" TEXT,
    "requested_discount_type" TEXT NOT NULL,
    "requested_discount_value" DECIMAL(10,2) NOT NULL,
    "minimum_quantity" INTEGER,
    "maximum_discount_amount" DECIMAL(10,2),
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "business_justification" TEXT,
    "estimated_impact" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "admin_notes" TEXT,
    "rejection_reason" TEXT,
    "requested_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "discount_approval_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."discount_approval_requests"
    ADD CONSTRAINT "discount_approval_requests_customer_fkey"
    FOREIGN KEY ("warehouse_customer_id") REFERENCES "public"."warehouse_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."discount_approval_requests"
    ADD CONSTRAINT "discount_approval_requests_product_fkey"
    FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."discount_approval_requests"
    ADD CONSTRAINT "discount_approval_requests_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."discount_approval_requests"
    ADD CONSTRAINT "discount_approval_requests_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Helpful indexes
CREATE INDEX "warehouse_customer_discounts_customer_idx" ON "public"."warehouse_customer_discounts" ("warehouse_customer_id");
CREATE INDEX "discount_approval_requests_customer_idx" ON "public"."discount_approval_requests" ("warehouse_customer_id");
CREATE INDEX "warehouse_sale_discounts_sale_idx" ON "public"."warehouse_sale_discounts" ("warehouse_sale_id");
