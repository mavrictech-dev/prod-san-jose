-- Candidato aditivo. Aplicar sólo a Identity local tras autorización y respaldo.
-- No migra historial, no cambia sedes, series ni cuentas existentes.
BEGIN;
CREATE TABLE IF NOT EXISTS "UserExtraPermission" (
  "userId" uuid NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  permission varchar(80) NOT NULL CHECK (permission IN ('document.view','document.issue','document.email','report.view','report.export','audit.view','shift.open','shift.close')),
  "assignedBy" uuid NOT NULL REFERENCES "User"(id),
  "assignedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", permission)
);
COMMIT;
