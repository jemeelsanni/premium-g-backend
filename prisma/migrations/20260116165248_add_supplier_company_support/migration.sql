-- CreateTable: Add supplier_companies table
CREATE TABLE "supplier_companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "contact_person" TEXT,
    "payment_terms" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_companies_name_key" ON "supplier_companies"("name");
CREATE UNIQUE INDEX "supplier_companies_code_key" ON "supplier_companies"("code");

-- Insert default "Rite Foods" supplier company
INSERT INTO "supplier_companies" ("id", "name", "code", "is_active", "created_at", "updated_at")
VALUES (gen_random_uuid()::text, 'Rite Foods', 'RFL', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- AlterTable: Add supplier_company_id to distribution_orders
ALTER TABLE "distribution_orders" ADD COLUMN "supplier_company_id" TEXT;

-- Set all existing orders to use Rite Foods as supplier
UPDATE "distribution_orders"
SET "supplier_company_id" = (SELECT "id" FROM "supplier_companies" WHERE "code" = 'RFL' LIMIT 1);

-- Rename columns in distribution_orders
ALTER TABLE "distribution_orders" RENAME COLUMN "paid_to_rite_foods" TO "paid_to_supplier";
ALTER TABLE "distribution_orders" RENAME COLUMN "amount_paid_to_rite_foods" TO "amount_paid_to_supplier";
ALTER TABLE "distribution_orders" RENAME COLUMN "payment_date_to_rite_foods" TO "payment_date_to_supplier";
ALTER TABLE "distribution_orders" RENAME COLUMN "rite_foods_order_number" TO "supplier_order_number";
ALTER TABLE "distribution_orders" RENAME COLUMN "rite_foods_invoice_number" TO "supplier_invoice_number";
ALTER TABLE "distribution_orders" RENAME COLUMN "rite_foods_status" TO "supplier_status";
ALTER TABLE "distribution_orders" RENAME COLUMN "order_raised_by_rfl" TO "order_raised_by_supplier";
ALTER TABLE "distribution_orders" RENAME COLUMN "rite_foods_loaded_date" TO "supplier_loaded_date";

-- Rename enum type
ALTER TYPE "RiteFoodsStatus" RENAME TO "SupplierStatus";

-- Update PaymentType enum value
ALTER TYPE "PaymentType" RENAME VALUE 'TO_RITE_FOODS' TO 'TO_SUPPLIER';

-- AddForeignKey
ALTER TABLE "distribution_orders" ADD CONSTRAINT "distribution_orders_supplier_company_id_fkey"
FOREIGN KEY ("supplier_company_id") REFERENCES "supplier_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
