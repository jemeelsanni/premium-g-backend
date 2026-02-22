-- CreateTable
CREATE TABLE "public"."supplier_targets" (
    "id" TEXT NOT NULL,
    "supplier_company_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "total_packs_target" INTEGER NOT NULL,
    "weeklyTargets" JSONB NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_targets_supplier_company_id_year_month_key" ON "public"."supplier_targets"("supplier_company_id", "year", "month");

-- AddForeignKey
ALTER TABLE "public"."supplier_targets" ADD CONSTRAINT "supplier_targets_supplier_company_id_fkey" FOREIGN KEY ("supplier_company_id") REFERENCES "public"."supplier_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."supplier_targets" ADD CONSTRAINT "supplier_targets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
