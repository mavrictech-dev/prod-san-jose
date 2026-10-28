-- Expansión aditiva; respaldo previo obligatorio. No habilita transmisión a SUNAT.
ALTER TABLE "FiscalCircuitQa" ADD COLUMN IF NOT EXISTS "xsdEvidence" JSONB;
-- Registros previos permanecen NULL: no atribuir una validación retroactiva.
