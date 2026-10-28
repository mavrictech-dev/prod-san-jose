# realtime-service

Gateway Socket.io sin persistencia fiscal propia. Consume eventos versionados
desde su cola BullMQ y los retransmite a salas autorizadas por usuario, punto de
emisión y turno.
# Runtime QA implementado

NestJS + Socket.io por Kong `/socket.io`, sesión activa comprobada en Identity y
autorización de cada aviso por API de Billing. Ninguna base de datos compartida.
Consume `workspace-live-notifications-v1`, no compite por la cola de estados fiscales.
Mensajes mínimos: `eventId/documentId`; el cliente vuelve a consultar por REST.
Auditoría de revocación cada 15 segundos y comprobación antes de cada aviso.
Sólo activado en `tests/compose.stage2.qa.yml`; una instancia, hasta 100 conexiones.
No es un fanout multi-instancia: escalar requiere un adaptador Socket.io y cambiar
la distribución de notificaciones. Fallos se recuperan mediante consultas REST.
