-- AlterTable
ALTER TABLE "public"."cash_flow" ADD COLUMN     "module" TEXT DEFAULT 'WAREHOUSE';

-- CreateIndex
CREATE INDEX "cash_flow_module_idx" ON "public"."cash_flow"("module");

-- CreateIndex
CREATE INDEX "cash_flow_cashier_idx" ON "public"."cash_flow"("cashier");

-- CreateIndex
CREATE INDEX "cash_flow_created_at_idx" ON "public"."cash_flow"("created_at");
