-- AlterTable
ALTER TABLE "public"."products" ALTER COLUMN "packs_per_pallet" DROP NOT NULL,
ALTER COLUMN "price_per_pack" DROP NOT NULL;
