-- Create supplier_products table
CREATE TABLE IF NOT EXISTS "supplier_products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplier_company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "supplier_cost_per_pack" DECIMAL(10,2) NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "minimum_order_packs" INTEGER,
    "lead_time_days" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_products_supplier_company_id_fkey"
        FOREIGN KEY ("supplier_company_id")
        REFERENCES "supplier_companies"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    CONSTRAINT "supplier_products_product_id_fkey"
        FOREIGN KEY ("product_id")
        REFERENCES "products"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

-- Create unique index to ensure one entry per supplier-product combination
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_products_supplier_company_id_product_id_key"
    ON "supplier_products"("supplier_company_id", "product_id");

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS "idx_supplier_products_supplier_id"
    ON "supplier_products"("supplier_company_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_products_product_id"
    ON "supplier_products"("product_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_products_is_available"
    ON "supplier_products"("is_available");
