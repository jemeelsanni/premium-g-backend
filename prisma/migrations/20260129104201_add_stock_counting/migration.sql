-- CreateEnum
CREATE TYPE "public"."StockCountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ADJUSTED');

-- CreateTable
CREATE TABLE "public"."stock_counts" (
    "id" TEXT NOT NULL,
    "count_number" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "location" TEXT,
    "counted_pallets" INTEGER NOT NULL,
    "counted_packs" INTEGER NOT NULL,
    "counted_units" INTEGER NOT NULL,
    "system_pallets" INTEGER NOT NULL,
    "system_packs" INTEGER NOT NULL,
    "system_units" INTEGER NOT NULL,
    "variance_pallets" INTEGER NOT NULL,
    "variance_packs" INTEGER NOT NULL,
    "variance_units" INTEGER NOT NULL,
    "variance_value" DECIMAL(12,2),
    "status" "public"."StockCountStatus" NOT NULL DEFAULT 'PENDING',
    "approval_notes" TEXT,
    "rejection_reason" TEXT,
    "adjustment_reason" TEXT,
    "counted_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "count_date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."stock_adjustments" (
    "id" TEXT NOT NULL,
    "stock_count_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "adjustment_pallets" INTEGER NOT NULL,
    "adjustment_packs" INTEGER NOT NULL,
    "adjustment_units" INTEGER NOT NULL,
    "before_pallets" INTEGER NOT NULL,
    "before_packs" INTEGER NOT NULL,
    "before_units" INTEGER NOT NULL,
    "after_pallets" INTEGER NOT NULL,
    "after_packs" INTEGER NOT NULL,
    "after_units" INTEGER NOT NULL,
    "adjustment_value" DECIMAL(12,2) NOT NULL,
    "adjustment_reason" TEXT NOT NULL,
    "adjusted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_count_number_key" ON "public"."stock_counts"("count_number");

-- CreateIndex
CREATE INDEX "stock_counts_product_id_idx" ON "public"."stock_counts"("product_id");

-- CreateIndex
CREATE INDEX "stock_counts_status_idx" ON "public"."stock_counts"("status");

-- CreateIndex
CREATE INDEX "stock_counts_count_date_idx" ON "public"."stock_counts"("count_date");

-- CreateIndex
CREATE INDEX "stock_counts_counted_by_idx" ON "public"."stock_counts"("counted_by");

-- CreateIndex
CREATE INDEX "stock_adjustments_stock_count_id_idx" ON "public"."stock_adjustments"("stock_count_id");

-- CreateIndex
CREATE INDEX "stock_adjustments_product_id_idx" ON "public"."stock_adjustments"("product_id");

-- AddForeignKey
ALTER TABLE "public"."stock_counts" ADD CONSTRAINT "stock_counts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_counts" ADD CONSTRAINT "stock_counts_counted_by_fkey" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_counts" ADD CONSTRAINT "stock_counts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_stock_count_id_fkey" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_adjusted_by_fkey" FOREIGN KEY ("adjusted_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
