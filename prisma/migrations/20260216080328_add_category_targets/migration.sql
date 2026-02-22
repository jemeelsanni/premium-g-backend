-- AlterTable
ALTER TABLE "public"."distribution_targets" ADD COLUMN     "category_targets" JSONB;

-- AlterTable
ALTER TABLE "public"."supplier_targets" ADD COLUMN     "category_targets" JSONB;
