-- CreateEnum
CREATE TYPE "public"."ProductModule" AS ENUM ('DISTRIBUTION', 'WAREHOUSE', 'BOTH');

-- AlterTable
ALTER TABLE "public"."products" ADD COLUMN     "module" "public"."ProductModule" NOT NULL DEFAULT 'DISTRIBUTION',
ALTER COLUMN "cost_per_pack" DROP NOT NULL,
ALTER COLUMN "cost_per_pack" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."truck_capacity" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "make" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "registration_number" TEXT,
ADD COLUMN     "year" INTEGER;
