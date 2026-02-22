-- CreateTable
CREATE TABLE "public"."supplier_incentives" (
    "id" TEXT NOT NULL,
    "supplier_company_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "incentive_percentage" DECIMAL(5,2) NOT NULL,
    "actual_incentive_paid" DECIMAL(12,2),
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_incentives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_incentives_supplier_company_id_year_month_key" ON "public"."supplier_incentives"("supplier_company_id", "year", "month");

-- AddForeignKey
ALTER TABLE "public"."supplier_incentives" ADD CONSTRAINT "supplier_incentives_supplier_company_id_fkey" FOREIGN KEY ("supplier_company_id") REFERENCES "public"."supplier_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."supplier_incentives" ADD CONSTRAINT "supplier_incentives_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
