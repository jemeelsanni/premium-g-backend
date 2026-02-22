-- CreateEnum
CREATE TYPE "public"."ProductCategoryType" AS ENUM ('CSD', 'ED', 'WATER', 'JUICE');

-- CreateEnum
CREATE TYPE "public"."SkuUnit" AS ENUM ('CL', 'L');

-- AlterTable
ALTER TABLE "public"."supplier_products" ADD COLUMN     "supplier_category_sku_id" TEXT;

-- CreateTable
CREATE TABLE "public"."supplier_categories" (
    "id" TEXT NOT NULL,
    "supplier_company_id" TEXT NOT NULL,
    "category_type" "public"."ProductCategoryType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."supplier_category_skus" (
    "id" TEXT NOT NULL,
    "supplier_category_id" TEXT NOT NULL,
    "sku_value" DECIMAL(8,2) NOT NULL,
    "sku_unit" "public"."SkuUnit" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_category_skus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_categories_supplier_company_id_category_type_key" ON "public"."supplier_categories"("supplier_company_id", "category_type");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_category_skus_supplier_category_id_sku_value_sku_u_key" ON "public"."supplier_category_skus"("supplier_category_id", "sku_value", "sku_unit");

-- AddForeignKey
ALTER TABLE "public"."supplier_categories" ADD CONSTRAINT "supplier_categories_supplier_company_id_fkey" FOREIGN KEY ("supplier_company_id") REFERENCES "public"."supplier_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."supplier_category_skus" ADD CONSTRAINT "supplier_category_skus_supplier_category_id_fkey" FOREIGN KEY ("supplier_category_id") REFERENCES "public"."supplier_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."supplier_products" ADD CONSTRAINT "supplier_products_supplier_category_sku_id_fkey" FOREIGN KEY ("supplier_category_sku_id") REFERENCES "public"."supplier_category_skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
