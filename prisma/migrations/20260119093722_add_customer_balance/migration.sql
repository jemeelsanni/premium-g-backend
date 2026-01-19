-- Add customer_balance field to customers table
-- Positive balance = customer overpaid (has credit with us)
-- Negative balance = customer owes us money (debt)

ALTER TABLE "customers" ADD COLUMN "customer_balance" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- Add comment to explain the field
COMMENT ON COLUMN "customers"."customer_balance" IS 'Customer balance: Positive = credit/overpayment, Negative = debt';
