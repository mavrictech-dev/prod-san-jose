ALTER TABLE "FiscalDispatchAuthorization" DROP CONSTRAINT IF EXISTS "FiscalDispatchAuthorization_profile_check";
ALTER TABLE "FiscalDispatchAuthorization" ADD CONSTRAINT "FiscalDispatchAuthorization_profile_check" CHECK ("profile" IN ('01-PEN-0101-IGV18-v1','01-03-PEN-0101-IGV18-v2','01-03-PEN-0101-TAX10-20-30-v3'));

ALTER TABLE "ProductionNotesGrant" DROP CONSTRAINT IF EXISTS "ProductionNotesGrant_profile_check";
ALTER TABLE "ProductionNotesGrant" ADD CONSTRAINT "ProductionNotesGrant_profile_check" CHECK ("profile" IN ('07-08-ON-01-PEN-0101-IGV18-v1','07-08-ON-01-03-PEN-0101-IGV18-v2','07-08-ON-01-03-PEN-0101-TAX10-20-30-v3'));
