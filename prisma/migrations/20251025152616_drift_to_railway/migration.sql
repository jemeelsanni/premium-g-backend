-- AlterTable
ALTER TABLE "public"."products" ADD COLUMN     "max_selling_price" DECIMAL(10,2),
ADD COLUMN     "min_selling_price" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "public"."warehouse_customers" ADD COLUMN     "last_payment_date" TIMESTAMP(3),
ADD COLUMN     "outstanding_debt" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "payment_reliability_score" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
ADD COLUMN     "total_credit_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "total_credit_purchases" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."warehouse_sales" ADD COLUMN     "credit_due_date" TIMESTAMP(3),
ADD COLUMN     "credit_notes" TEXT,
ADD COLUMN     "payment_status" TEXT DEFAULT 'PAID';

-- CreateTable
CREATE TABLE "public"."warehouse_product_purchases" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "vendor_name" TEXT NOT NULL,
    "vendor_phone" TEXT,
    "vendor_email" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_type" "public"."UnitType" NOT NULL,
    "cost_per_unit" DECIMAL(10,2) NOT NULL,
    "total_cost" DECIMAL(12,2) NOT NULL,
    "payment_method" "public"."PaymentMethod" NOT NULL,
    "payment_status" TEXT NOT NULL DEFAULT 'PAID',
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_due" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "purchase_date" TIMESTAMP(3) NOT NULL,
    "invoice_number" TEXT,
    "receipt_url" TEXT,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_product_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."warehouse_debtors" (
    "id" TEXT NOT NULL,
    "warehouse_customer_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_due" DECIMAL(12,2) NOT NULL,
    "due_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OUTSTANDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_debtors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."warehouse_debtor_payments" (
    "id" TEXT NOT NULL,
    "debtor_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_method" "public"."PaymentMethod" NOT NULL,
    "payment_date" TIMESTAMP(3) NOT NULL,
    "reference_number" TEXT,
    "notes" TEXT,
    "received_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_debtor_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_debtors_sale_id_key" ON "public"."warehouse_debtors"("sale_id");

-- AddForeignKey
ALTER TABLE "public"."warehouse_product_purchases" ADD CONSTRAINT "warehouse_product_purchases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_product_purchases" ADD CONSTRAINT "warehouse_product_purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_debtors" ADD CONSTRAINT "warehouse_debtors_warehouse_customer_id_fkey" FOREIGN KEY ("warehouse_customer_id") REFERENCES "public"."warehouse_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_debtors" ADD CONSTRAINT "warehouse_debtors_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."warehouse_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_debtor_payments" ADD CONSTRAINT "warehouse_debtor_payments_debtor_id_fkey" FOREIGN KEY ("debtor_id") REFERENCES "public"."warehouse_debtors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_debtor_payments" ADD CONSTRAINT "warehouse_debtor_payments_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
