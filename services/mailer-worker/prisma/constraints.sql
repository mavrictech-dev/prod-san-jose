-- Incorporar estas restricciones a la migración inicial generada por Prisma.
ALTER TABLE "SmtpSettings"
  ADD CONSTRAINT "SmtpSettings_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "SmtpSettings_port_range" CHECK ("port" BETWEEN 1 AND 65535);
