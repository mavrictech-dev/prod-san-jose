# Correo de desarrollo

Microservicio NestJS independiente, BullMQ y propia base `factuez_mailer_qa`.
Inicializar sólo esta base nueva con `prisma/local-qa-init.sql`; no ejecutar
db push sobre bases existentes. El schema conserva los modelos planificados para
SMTP corporativo, pero este incremento sólo crea/usa `LocalQaMail`.

`POST/GET /api/v1/mail-qa/:documentId`, autenticado por Identity y alcance Billing.
ADMIN GLOBAL / document.email, RUC ficticio 00..., BETA y CDR simulado disponible.
Destinatarios exclusivamente `.invalid`. Mailpit interno sin relay/puertos públicos.
SMTP fijado al capturador local; no acepta host, credenciales o destinatarios externos.

Paquete privado: PDF y ZIP de XML firmado/CDR simulado, checksum previo al SMTP.
No JWT persistidos. Claim/idempotencia/estado incierto sin reenvío automático.
CAPTURED_LOCAL no significa enviado a clientes. Consultar el detalle PWA y ejecutar
`pnpm test:print-mail-live:e2e` / `pnpm qa:mail:capture` para comprobar el circuito.

SMTP real, adjuntos oficiales, envío automático al emitir, retención/purga de
paquetes huérfanos y una bandeja de administración completa siguen pendientes.
