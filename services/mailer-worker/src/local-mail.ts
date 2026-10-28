import { BadRequestException, ConflictException, ForbiddenException, Injectable, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { identity, authorizedDocument, privateJson, redisConnection, LivePublisher, UUID } from '@factuez/service-access';
import { Queue, Worker } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { LocalCaptureSmtp } from './capture-smtp';
import { unzipSync, zipSync } from 'fflate';
import { PrismaService } from './prisma.service';

export function localRecipient(value: unknown) {
  if (typeof value !== 'string' || value.length > 254 || !/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.invalid$/i.test(value))
    throw new BadRequestException('Use sólo un correo ficticio, por ejemplo cliente@pruebas.invalid');
  return value.toLowerCase();
}
type Attachment = { key: string; filename: string; type: string; size: number; sha256: string };
type Manifest = { subject: string; attachments: Attachment[] };
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const queueName = 'mail-local-qa-v1';
@Injectable()
export class LocalMail implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue; private worker?: Worker; private timer?: NodeJS.Timeout;
  private stopped = false; private dispatching?: Promise<void>; private closing?: Promise<void>;
  private readonly live = new LivePublisher();
  private readonly root = resolve(process.env.MAIL_QA_ROOT ?? '/data/mail-qa');
  constructor(private readonly prisma: PrismaService, private readonly smtp: LocalCaptureSmtp) {}
  private enabled() { if (this.stopped || process.env.LOCAL_MAIL_QA_ENABLED !== 'true') throw new ServiceUnavailableException('Correo de prueba deshabilitado'); }
  private async context(id: string, authorization: string) {
    this.enabled(); const user = await identity(authorization, 'document.email');
    // El circuito firmado QA sólo se expone a ADMIN GLOBAL, también en su microservicio propietario.
    if (!user.roles.includes('ADMIN') || user.scope.kind !== 'GLOBAL') throw new ForbiddenException('Correo de laboratorio sólo para administrador general');
    const document = await authorizedDocument(id, authorization);
    if (document.immutableSnapshot.environment !== 'BETA' || !/^00\d{9}$/.test(document.immutableSnapshot.issuer.identityNumber)) throw new BadRequestException('Sólo documentos ficticios de desarrollo');
    return { user, document };
  }
  private view(row: { id: string; recipient: string; format: string; status: string; description: string | null; createdAt: Date; capturedAt: Date | null; manifest: unknown }) {
    const manifest = row.manifest as Manifest;
    return { id: row.id, recipient: row.recipient, format: row.format, status: row.status, description: row.description, createdAt: row.createdAt, capturedAt: row.capturedAt,
      attachments: manifest.attachments.map(file => ({ filename: file.filename, sha256: file.sha256, size: file.size })), transport: 'LOCAL_MAILPIT', deliveredToClient: false, officialCdr: false };
  }
  async status(id: string, authorization: string) {
    await this.context(id, authorization);
    return { transport: 'LOCAL_MAILPIT', deliveredToClient: false, deliveries: (await this.prisma.localQaMail.findMany({ where: { documentId: id }, orderBy: { createdAt: 'desc' }, take: 10 })).map(row => this.view(row)) };
  }
  private async artifact(id: string, format: string, authorization: string, type: string) {
    const response = await fetch(`${process.env.SUNAT_INTERNAL_URL ?? 'http://sunat-service:3003'}/api/v1/fiscal-circuit-qa/${id}/${format}`, { headers: { Authorization: authorization, Accept: type, 'Cache-Control': 'no-store' }, redirect: 'error', signal: AbortSignal.timeout(25000) });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== type) { await response.body?.cancel(); throw new ConflictException('El paquete firmado de prueba no está disponible'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 5 * 1024 * 1024) throw new Error(); chunks.push(part.value); } return Buffer.concat(chunks); }
    catch { await reader.cancel().catch(() => {}); throw new ConflictException('Adjunto de prueba excede los límites'); }
  }
  private async save(id: string, name: string, bytes: Buffer, type: string): Promise<Attachment> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const canonical = await realpath(this.root);
    const key = `${id}/${randomUUID()}`; const target = resolve(canonical, key); const folder = dirname(target);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (await realpath(folder) !== folder || !target.startsWith(canonical + sep)) throw new Error('Almacenamiento inseguro');
    const file = await open(target, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    return { key, filename: name, type, size: bytes.length, sha256: sha256(bytes) };
  }
  async enqueue(id: string, body: { recipient?: unknown; format?: unknown }, authorization: string) {
    const recipient = localRecipient(body?.recipient); const format = body?.format ?? 'ticket';
    if (!['ticket','a4'].includes(String(format))) throw new BadRequestException('Formato inválido');
    const { document, user } = await this.context(id, authorization);
    const prior = await this.prisma.localQaMail.findUnique({ where: { documentId_recipient_format: { documentId: id, recipient, format: String(format) } } });
    if (prior) return this.view(prior);
    if (await this.prisma.localQaMail.count({ where: { documentId: id } }) >= 10 || await this.prisma.localQaMail.count({ where: { actorId: user.sub, status: { in: ['QUEUED','SENDING','RETRYABLE_ERROR'] } } }) >= 50) throw new ConflictException('Límite de correo QA alcanzado');
    const circuit = await privateJson<{ state: string; cdrAvailable: boolean; requestFileName: string }>(process.env.SUNAT_INTERNAL_URL ?? 'http://sunat-service:3003', `/api/v1/fiscal-circuit-qa/${id}`, authorization);
    if (!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(circuit.state) || !circuit.cdrAvailable) throw new ConflictException('Primero complete el circuito simulado con CDR');
    const [pdf, xml, cdrZip] = await Promise.all([this.artifact(id, String(format), authorization, 'application/pdf'), this.artifact(id, 'xml', authorization, 'application/xml'), this.artifact(id, 'cdr', authorization, 'application/zip')]);
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new ConflictException('PDF inválido');
    const expected = `R-${circuit.requestFileName.replace(/\.zip$/, '.xml')}`; let count = 0;
    const entries = unzipSync(cdrZip, { filter: file => { if (++count !== 1 || file.name !== expected || file.originalSize > 2 * 1024 * 1024) throw new Error('CDR inválido'); return true; } });
    if (Object.keys(entries).length !== 1 || !entries[expected]) throw new ConflictException('CDR inválido');
    const snapshot = document.immutableSnapshot;
    const name = `${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}`;
    if (!/^00\d{9}-(01|03)-[BF][A-Z0-9]{3}-[1-9]\d{0,7}$/.test(name)) throw new ConflictException('Nombre de archivo QA inválido');
    const pack = Buffer.from(zipSync({ [`${name}-SIMULADO.xml`]: xml, [expected]: entries[expected] }));
    const manifest: Manifest = { subject: `PRUEBA SIN VALIDEZ · ${name}`, attachments: await Promise.all([
      this.save(id, `${name}-${format}-SIMULADO.pdf`, pdf, 'application/pdf'), this.save(id, `${name}-XML-CDR-SIMULADO.zip`, pack, 'application/zip'),
    ]) };
    await this.context(id, authorization); // revalidar al admitir la tarea; JWT nunca se persiste.
    const row = await this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', `mail-qa:${id}`);
      const existing = await tx.localQaMail.findUnique({ where: { documentId_recipient_format: { documentId: id, recipient, format: String(format) } } });
      if (existing) return existing;
      if (await tx.localQaMail.count({ where: { documentId: id } }) >= 10) throw new ConflictException('Límite de correo QA alcanzado');
      return tx.localQaMail.create({ data: { documentId: id, actorId: user.sub, recipient, format: String(format), manifest } });
    });
    await this.live.changed(id); return this.view(row);
  }
  onApplicationBootstrap() {
    if (this.stopped || this.queue || process.env.LOCAL_MAIL_QA_ENABLED !== 'true') return;
    this.queue = new Queue(queueName, { connection: redisConnection() });
    this.queue.on('error', () => {});
    this.worker = new Worker(queueName, job => this.process(String(job.data.id)), { connection: redisConnection(), concurrency: 1 });
    this.worker.on('error', () => {}); this.timer = setInterval(() => void this.dispatch(), 2000);
  }
  private dispatch(): Promise<void> {
    if (this.stopped || !this.queue) return Promise.resolve();
    return this.dispatching ??= this.dispatchBatch().finally(() => { this.dispatching = undefined; });
  }
  private async dispatchBatch() {
    try {
      await this.prisma.localQaMail.updateMany({ where: { status: 'SENDING', claimedAt: { lt: new Date(Date.now() - 60000) } }, data: { status: 'UNKNOWN', description: 'Resultado incierto; revisar captura antes de reenviar' } });
      const rows = await this.prisma.localQaMail.findMany({ where: { status: { in: ['QUEUED','RETRYABLE_ERROR'] }, nextAttemptAt: { lte: new Date() } }, take: 20 });
      for (const row of rows) {
        if (this.stopped) break;
        await this.queue!.add('capture', { id: row.id }, { jobId: `${row.id}-${row.attempt}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
      }
    } catch { /* PostgreSQL conserva la tarea. */ }
  }
  async process(id: string) {
    this.enabled(); if (!UUID.test(id)) return;
    const row = await this.prisma.localQaMail.findUnique({ where: { id } }); if (!row || !['QUEUED','RETRYABLE_ERROR'].includes(row.status)) return;
    const claim = await this.prisma.localQaMail.updateMany({ where: { id, status: row.status, attempt: row.attempt }, data: { status: 'SENDING', attempt: { increment: 1 }, claimedAt: new Date() } }); if (claim.count !== 1) return;
    let attempting = false;
    try {
      localRecipient(row.recipient); const manifest = row.manifest as unknown as Manifest;
      const attachments = await Promise.all(manifest.attachments.map(async file => {
        if (!new RegExp(`^${row.documentId}/[0-9a-f-]{36}$`).test(file.key) || file.size > 5 * 1024 * 1024) throw new Error();
        const canonical = await realpath(this.root); const target = resolve(canonical, file.key);
        if (!target.startsWith(canonical + sep) || await realpath(target) !== target) throw new Error();
        const bytes = await readFile(target); if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error();
        return { filename: file.filename, content: bytes, contentType: file.type };
      }));
      attempting = true;
      const result = await this.smtp.capture({ from: 'FactuEz QA <factuez@pruebas.invalid>', to: row.recipient, subject: manifest.subject, messageId: `<${row.id}@factuez.invalid>`,
        text: 'DOCUMENTO FICTICIO DE DESARROLLO. Sin validez tributaria. XML firmado con certificado de pruebas y CDR simulado, NO oficial. Capturado localmente; no enviado a clientes. Desarrollado e implementado por www.mavrictec.com', attachments });
      await this.prisma.localQaMail.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'CAPTURED_LOCAL', capturedAt: new Date(), messageId: result.messageId, description: 'Capturado en Mailpit local; no entregado a un cliente' } });
    } catch (reason) {
      const error = reason as { code?: string; command?: string };
      const safeRetry = attempting && error.command === 'CONN' && ['ECONNREFUSED','EAI_AGAIN','ETIMEDOUT'].includes(error.code ?? '') && row.attempt < 2;
      await this.prisma.localQaMail.updateMany({ where: { id, status: 'SENDING' }, data: { status: safeRetry ? 'RETRYABLE_ERROR' : attempting ? 'UNKNOWN' : 'FAILED',
        description: safeRetry ? 'Capturador no disponible; reintento local pendiente' : attempting ? 'Resultado SMTP incierto; revisar Mailpit, sin reenvío automático' : 'Falló la integridad de los adjuntos; no enviado', nextAttemptAt: new Date(Date.now() + 5000 * 2 ** row.attempt) } });
    }
    await this.live.changed(row.documentId);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.closing = (async () => {
      let failed = false;
      try { await this.dispatching; } catch { failed = true; }
      try { await this.worker?.close(); } catch { failed = true; }
      try { await this.queue?.close(); } catch { failed = true; }
      try { await this.live.close(); } catch { failed = true; }
      if (failed) throw Error('LOCAL_MAIL_CLOSE_FAILED');
    })();
    return this.closing;
  }
  onModuleDestroy() { return this.close(); }
}
