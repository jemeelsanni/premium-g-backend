-- CreateTable: supplier_products (junction table for suppliers and products)
CREATE TABLE IF NOT EXISTS "supplier_products" (
    "id" TEXT NOT NULL,
    "supplier_company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "supplier_cost_per_pack" DECIMAL(10,2) NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "minimum_order_packs" INTEGER,
    "lead_time_days" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_products_supplier_company_id_product_id_key" ON "supplier_products"("supplier_company_id", "product_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_supplier_products_supplier_id" ON "supplier_products"("supplier_company_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_supplier_products_product_id" ON "supplier_products"("product_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_supplier_products_is_available" ON "supplier_products"("is_available");

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_company_id_fkey" FOREIGN KEY ("supplier_company_id") REFERENCES "supplier_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: supplier_product_price_history
CREATE TABLE IF NOT EXISTS "supplier_product_price_history" (
    "id" TEXT NOT NULL,
    "supplier_product_id" TEXT NOT NULL,
    "old_price" DECIMAL(10,2) NOT NULL,
    "new_price" DECIMAL(10,2) NOT NULL,
    "changed_by" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_product_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "supplier_product_price_history_supplier_product_id_idx" ON "supplier_product_price_history"("supplier_product_id");

-- AddForeignKey
ALTER TABLE "supplier_product_price_history" ADD CONSTRAINT "supplier_product_price_history_supplier_product_id_fkey" FOREIGN KEY ("supplier_product_id") REFERENCES "supplier_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_product_price_history" ADD CONSTRAINT "supplier_product_price_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
