-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN', 'DISTRIBUTION_SALES_REP', 'WAREHOUSE_SALES_OFFICER', 'CASHIER', 'TRANSPORT_STAFF');

-- CreateEnum
CREATE TYPE "public"."OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."DeliveryStatus" AS ENUM ('ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'DELAYED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ExpenseType" AS ENUM ('TRUCK_EXPENSE', 'TRANSPORT_EXPENSE', 'DISTRIBUTION_EXPENSE', 'WAREHOUSE_EXPENSE', 'FUEL_COST', 'MAINTENANCE', 'SALARY_WAGES', 'OPERATIONAL', 'SERVICE_CHARGE');

-- CreateEnum
CREATE TYPE "public"."ExpenseCategory" AS ENUM ('FUEL', 'MAINTENANCE', 'REPAIRS', 'INSURANCE', 'DRIVER_WAGES', 'SERVICE_CHARGES', 'EQUIPMENT', 'UTILITIES', 'RENT', 'OFFICE_SUPPLIES', 'MARKETING', 'TRANSPORT_SERVICE_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "public"."AnalysisType" AS ENUM ('ORDER', 'TRANSPORT_TRIP', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'LOCATION', 'CUSTOMER', 'PRODUCT');

-- CreateEnum
CREATE TYPE "public"."UnitType" AS ENUM ('PALLETS', 'PACKS', 'UNITS');

-- CreateEnum
CREATE TYPE "public"."PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY');

-- CreateEnum
CREATE TYPE "public"."TransactionType" AS ENUM ('CASH_IN', 'CASH_OUT', 'SALE', 'EXPENSE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "public"."KPIType" AS ENUM ('OVERALL_PERFORMANCE', 'DISTRIBUTION_PERFORMANCE', 'TRANSPORT_PERFORMANCE', 'WAREHOUSE_PERFORMANCE', 'PROFITABILITY', 'EFFICIENCY', 'TARGET_ACHIEVEMENT');

-- CreateEnum
CREATE TYPE "public"."PeriodType" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateTable
CREATE TABLE "public"."users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "public"."UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "permissions" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."distribution_targets" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "total_packs_target" INTEGER NOT NULL,
    "weeklyTargets" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribution_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."weekly_performance" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "week_number" INTEGER NOT NULL,
    "target_packs" INTEGER NOT NULL,
    "actual_packs" INTEGER NOT NULL DEFAULT 0,
    "percentage_achieved" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "week_start_date" TIMESTAMP(3) NOT NULL,
    "week_end_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_performance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."products" (
    "id" TEXT NOT NULL,
    "product_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "packs_per_pallet" INTEGER NOT NULL,
    "price_per_pack" DECIMAL(10,2) NOT NULL,
    "cost_per_pack" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "fuel_adjustment" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "driver_wages_per_trip" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "delivery_notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."distribution_orders" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "total_pallets" INTEGER NOT NULL,
    "total_packs" INTEGER NOT NULL,
    "original_amount" DECIMAL(12,2) NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "final_amount" DECIMAL(12,2) NOT NULL,
    "status" "public"."OrderStatus" NOT NULL DEFAULT 'PENDING',
    "transporter_company" TEXT,
    "driver_number" TEXT,
    "remark" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribution_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."distribution_order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "pallets" INTEGER NOT NULL,
    "packs" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "distribution_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."pallet_pricing" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "location_id" TEXT,
    "price_per_pack" DECIMAL(10,2) NOT NULL,
    "fuel_adjustment" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "effective_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pallet_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."price_adjustments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "original_amount" DECIMAL(12,2) NOT NULL,
    "adjusted_amount" DECIMAL(12,2) NOT NULL,
    "adjustment_type" TEXT NOT NULL,
    "reason" TEXT,
    "location_fuel_cost" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."truck_capacity" (
    "id" TEXT NOT NULL,
    "truck_id" TEXT NOT NULL,
    "max_pallets" INTEGER NOT NULL DEFAULT 12,
    "current_load" INTEGER NOT NULL DEFAULT 0,
    "available_space" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "truck_capacity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."transport_orders" (
    "id" TEXT NOT NULL,
    "distribution_order_id" TEXT,
    "order_number" TEXT NOT NULL,
    "invoice_number" TEXT,
    "location_id" TEXT NOT NULL,
    "truck_id" TEXT,
    "total_order_amount" DECIMAL(12,2) NOT NULL,
    "fuel_required" DECIMAL(8,2) NOT NULL,
    "fuel_price_per_liter" DECIMAL(6,2) NOT NULL,
    "total_fuel_cost" DECIMAL(10,2) NOT NULL,
    "service_charge_expense" DECIMAL(10,2) NOT NULL,
    "driver_wages" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "truck_expenses" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_expenses" DECIMAL(12,2) NOT NULL,
    "gross_profit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_profit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "profit_margin" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "driverDetails" TEXT,
    "delivery_status" "public"."OrderStatus" NOT NULL DEFAULT 'PENDING',
    "delivery_date" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."expenses" (
    "id" TEXT NOT NULL,
    "expense_type" "public"."ExpenseType" NOT NULL,
    "category" "public"."ExpenseCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "reference_id" TEXT,
    "expense_date" TIMESTAMP(3) NOT NULL,
    "location_id" TEXT,
    "truck_id" TEXT,
    "department_id" TEXT,
    "status" "public"."ExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "receipt_url" TEXT,
    "receipt_number" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."profit_analysis" (
    "id" TEXT NOT NULL,
    "analysis_type" "public"."AnalysisType" NOT NULL,
    "reference_id" TEXT,
    "period" TEXT,
    "total_revenue" DECIMAL(15,2) NOT NULL,
    "distribution_revenue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "transport_revenue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "warehouse_revenue" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_costs" DECIMAL(15,2) NOT NULL,
    "cost_of_goods_sold" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "transport_costs" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "warehouse_cogs" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "fuel_costs" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "driver_wages" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "truck_expenses" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "service_charges" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "operational_expenses" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "gross_profit" DECIMAL(15,2) NOT NULL,
    "net_profit" DECIMAL(15,2) NOT NULL,
    "profit_margin" DECIMAL(5,2) NOT NULL,
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "total_packs" INTEGER NOT NULL DEFAULT 0,
    "average_order_value" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profit_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."warehouse_inventory" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "pallets" INTEGER NOT NULL DEFAULT 0,
    "packs" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER NOT NULL DEFAULT 0,
    "max_stock_level" INTEGER,
    "location" TEXT,
    "last_updated" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."warehouse_sales" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_type" "public"."UnitType" NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "cost_per_unit" DECIMAL(10,2) NOT NULL,
    "total_cost" DECIMAL(10,2) NOT NULL,
    "gross_profit" DECIMAL(10,2) NOT NULL,
    "profit_margin" DECIMAL(5,2) NOT NULL,
    "payment_method" "public"."PaymentMethod" NOT NULL,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "receipt_number" TEXT NOT NULL,
    "sales_officer" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."cash_flow" (
    "id" TEXT NOT NULL,
    "transaction_type" "public"."TransactionType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_method" "public"."PaymentMethod" NOT NULL,
    "description" TEXT,
    "reference_number" TEXT,
    "reconciliation_date" DATE,
    "is_reconciled" BOOLEAN NOT NULL DEFAULT false,
    "cashier" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."kpi_metrics" (
    "id" TEXT NOT NULL,
    "metric_type" "public"."KPIType" NOT NULL,
    "period" TEXT NOT NULL,
    "period_type" "public"."PeriodType" NOT NULL,
    "total_revenue" DECIMAL(15,2),
    "total_profit" DECIMAL(15,2),
    "profit_margin" DECIMAL(5,2),
    "cost_ratio" DECIMAL(5,2),
    "total_orders" INTEGER,
    "total_packs_sold" INTEGER,
    "target_achievement" DECIMAL(5,2),
    "on_time_delivery_rate" DECIMAL(5,2),
    "revenue_per_truck_trip" DECIMAL(10,2),
    "cost_per_pack" DECIMAL(8,2),
    "fuel_efficiency" DECIMAL(8,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kpi_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."system_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "public"."users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_key" ON "public"."user_sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "distribution_targets_year_month_key" ON "public"."distribution_targets"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_performance_target_id_week_number_key" ON "public"."weekly_performance"("target_id", "week_number");

-- CreateIndex
CREATE UNIQUE INDEX "products_product_no_key" ON "public"."products"("product_no");

-- CreateIndex
CREATE UNIQUE INDEX "truck_capacity_truck_id_key" ON "public"."truck_capacity"("truck_id");

-- CreateIndex
CREATE UNIQUE INDEX "transport_orders_distribution_order_id_key" ON "public"."transport_orders"("distribution_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "transport_orders_order_number_key" ON "public"."transport_orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_inventory_product_id_location_key" ON "public"."warehouse_inventory"("product_id", "location");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_sales_receipt_number_key" ON "public"."warehouse_sales"("receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_metrics_metric_type_period_period_type_key" ON "public"."kpi_metrics"("metric_type", "period", "period_type");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_key_key" ON "public"."system_config"("key");

-- AddForeignKey
ALTER TABLE "public"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."weekly_performance" ADD CONSTRAINT "weekly_performance_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."distribution_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."distribution_orders" ADD CONSTRAINT "distribution_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."distribution_orders" ADD CONSTRAINT "distribution_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."distribution_orders" ADD CONSTRAINT "distribution_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."distribution_order_items" ADD CONSTRAINT "distribution_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."distribution_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."distribution_order_items" ADD CONSTRAINT "distribution_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pallet_pricing" ADD CONSTRAINT "pallet_pricing_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pallet_pricing" ADD CONSTRAINT "pallet_pricing_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."price_adjustments" ADD CONSTRAINT "price_adjustments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."distribution_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transport_orders" ADD CONSTRAINT "transport_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transport_orders" ADD CONSTRAINT "transport_orders_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "public"."truck_capacity"("truck_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transport_orders" ADD CONSTRAINT "transport_orders_distribution_order_id_fkey" FOREIGN KEY ("distribution_order_id") REFERENCES "public"."distribution_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."transport_orders" ADD CONSTRAINT "transport_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "public"."truck_capacity"("truck_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."expenses" ADD CONSTRAINT "expenses_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."profit_analysis" ADD CONSTRAINT "profit_analysis_distribution_order_fkey" FOREIGN KEY ("reference_id") REFERENCES "public"."distribution_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."profit_analysis" ADD CONSTRAINT "profit_analysis_transport_order_fkey" FOREIGN KEY ("reference_id") REFERENCES "public"."transport_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_inventory" ADD CONSTRAINT "warehouse_inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_sales" ADD CONSTRAINT "warehouse_sales_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouse_sales" ADD CONSTRAINT "warehouse_sales_sales_officer_fkey" FOREIGN KEY ("sales_officer") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."cash_flow" ADD CONSTRAINT "cash_flow_cashier_fkey" FOREIGN KEY ("cashier") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
