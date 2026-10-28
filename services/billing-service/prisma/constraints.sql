-- Incorporar estas restricciones a la migración inicial generada por Prisma.
ALTER TABLE "CompanySettings"
  ADD CONSTRAINT "CompanySettings_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "CompanySettings_ruc_format" CHECK ("ruc" ~ '^[0-9]{11}$'),
  ADD CONSTRAINT "CompanySettings_ubigeo_format" CHECK ("ubigeo" ~ '^[0-9]{6}$'),
  ADD CONSTRAINT "CompanySettings_igv_rate" CHECK ("igvRate" >= 0 AND "igvRate" <= 100);

ALTER TABLE "SeriesCounter"
  ADD CONSTRAINT "SeriesCounter_next_positive" CHECK ("nextNumber" > 0),
  ADD CONSTRAINT "SeriesCounter_series_format" CHECK ("series" ~ '^[A-Z0-9]{4}$');

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_number_positive" CHECK ("number" > 0),
  ADD CONSTRAINT "Document_amounts_nonnegative" CHECK (
    "taxableAmount" >= 0 AND "exemptAmount" >= 0 AND
    "unaffectedAmount" >= 0 AND "freeAmount" >= 0 AND
    "discountTotal" >= 0 AND "igvAmount" >= 0 AND
    "iscAmount" >= 0 AND "otherTaxesAmount" >= 0 AND
    "payableAmount" >= 0
  );

ALTER TABLE "DocumentItem"
  ADD CONSTRAINT "DocumentItem_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "DocumentItem_amounts_nonnegative" CHECK (
    "unitValue" >= 0 AND "unitPriceWithTax" >= 0 AND
    "discountAmount" >= 0 AND "lineExtensionAmount" >= 0 AND
    "igvAmount" >= 0 AND "iscAmount" >= 0 AND "totalAmount" >= 0
  );
