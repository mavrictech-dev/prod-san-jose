import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Server, type Socket } from 'socket.io';
import { Worker } from 'bullmq';
import { bearer, identity, authorizedDocument, privateJson, UUID, LIVE_QUEUE, redisConnection } from '@factuez/service-access';
@Controller('health') class Health { @Get() health() { return { status: 'ok', service: 'realtime', transport: 'socket.io', fiscalTransmission: false }; } }
@Module({ controllers: [Health] }) class AppModule {}

async function bootstrap() {
  if (process.env.WORKSPACE_LIVE_ENABLED !== 'true') throw new Error('Realtime QA no habilitado');
  const app = await NestFactory.create(AppModule);
  const allowed = new Set((process.env.WS_ALLOWED_ORIGINS ?? 'http://127.0.0.1:8091,http://localhost:8091').split(','));
  const io = new Server(app.getHttpServer(), {
    path: '/socket.io', transports: ['websocket'], maxHttpBufferSize: 8192,
    allowRequest: (request, callback) => callback(null, typeof request.headers.origin === 'string' && allowed.has(request.headers.origin)),
  });
  io.use(async (socket, next) => {
    try {
      if (io.engine.clientsCount > 100) throw new Error();
      const authorization = bearer(socket.handshake.auth?.token);
      const user = await identity(authorization);
      socket.data.authorization = authorization; socket.data.subject = user.sub;
      next();
    } catch { next(new Error('Sesión o permisos no disponibles')); }
  });
  const check = async (socket: Socket) => {
    const user = await identity(socket.data.authorization);
    if (user.sub !== socket.data.subject) throw new Error();
  };
  let auditing = false;
  const timer = setInterval(() => {
    if (auditing) return; auditing = true;
    void (async () => {
      try {
        const sockets = [...io.sockets.sockets.values()];
        for (let index = 0; index < sockets.length; index += 8) await Promise.all(sockets.slice(index,index+8).map(async socket => {
          try { await check(socket); } catch { socket.emit('session.invalid'); socket.disconnect(true); }
        }));
      }
      finally { auditing = false; }
    })();
  }, 15000);
  const worker = new Worker(LIVE_QUEUE, async job => {
    if (job.name === 'received.changed.v1') {
      const id = job.data?.receivedDocumentId;
      if (typeof id !== 'string' || !UUID.test(id)) return;
      const sockets = [...io.sockets.sockets.values()];
      for (let index = 0; index < sockets.length; index += 8) await Promise.all(sockets.slice(index, index + 8).map(async socket => {
        try {
          await check(socket);
          const detail = await privateJson<{ id: string }>(process.env.RECEIVED_INTERNAL_URL ?? 'http://received-documents-service:3006', `/api/v1/received-documents/${id}`, socket.data.authorization);
          if (detail.id === id && socket.connected) socket.emit('received.changed.v1', { eventId: String(job.id), receivedDocumentId: id });
        } catch { /* Fresh reception API scope required; no broadcast of purchase metadata. */ }
      }));
      return;
    }
    const documentId = job.data?.documentId;
    if (typeof documentId !== 'string' || !UUID.test(documentId)) return;
    // Ninguna sala global/por RUC proporcionada por el cliente. Reautorizar cada aviso.
    const sockets = [...io.sockets.sockets.values()];
    for (let index = 0; index < sockets.length; index += 8) {
      await Promise.all(sockets.slice(index, index + 8).map(async socket => {
        try {
          await check(socket);
          await authorizedDocument(documentId, socket.data.authorization);
          if (socket.connected) socket.emit('document.changed.v1', { eventId: String(job.id), documentId });
        } catch { /* Documento ajeno, revocación o caída: no emitir datos. */ }
      }));
    }
  }, { connection: redisConnection(), concurrency: 1 });
  worker.on('error', () => {});
  const stop = async () => { clearInterval(timer); await worker.close(); await new Promise<void>(resolve => io.close(() => resolve())); await app.close(); };
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
  await app.listen(Number(process.env.PORT ?? 3005), '0.0.0.0');
}
void bootstrap();
