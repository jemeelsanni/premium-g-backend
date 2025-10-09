-- Remove unique constraint on receipt_number to allow grouping multiple products under one sale
DROP INDEX IF EXISTS "warehouse_sales_receipt_number_key";
