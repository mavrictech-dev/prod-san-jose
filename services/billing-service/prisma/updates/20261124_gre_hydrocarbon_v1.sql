-- Additive; existing products are NOT silently declared non-regulated or granted fuel issuance.
ALTER TABLE "FuelProduct" ADD COLUMN IF NOT EXISTS "greGoodsFamily" varchar(24) NOT NULL DEFAULT 'UNCLASSIFIED';
ALTER TABLE "FuelProduct" ADD CONSTRAINT "FuelProduct_greGoodsFamily_check"
 CHECK ("greGoodsFamily" IN ('UNCLASSIFIED','NON_REGULATED','DIESEL','GASOHOL_PREMIUM','GASOHOL_REGULAR','GLP','GNV'));
