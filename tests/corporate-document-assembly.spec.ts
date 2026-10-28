import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Module } from '../services/mailer-worker/node_modules/@nestjs/common';
import { NestFactory } from '../services/mailer-worker/node_modules/@nestjs/core';
import { CORPORATE_DOCUMENT_CONTROLLERS, CORPORATE_DOCUMENT_PROVIDERS } from '../services/mailer-worker/src/corporate-document-module';
import { CorporateDocumentController } from '../services/mailer-worker/src/corporate-document-controller';
import { CorporateDocumentService } from '../services/mailer-worker/src/corporate-document-service';
import { CorporateDocumentWorker } from '../services/mailer-worker/src/corporate-document-worker';
import { CorporateDocumentStore } from '../services/mailer-worker/src/corporate-document-store';
import { CorporateDocumentHealth } from '../services/mailer-worker/src/corporate-document-health';
import { PrismaService } from '../services/mailer-worker/src/prisma.service';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('ensamblaje Nest operativo del bloque DOCUMENT', () => {
  it('proveedores resuelven sin habilitar worker/red cuando flags false', async () => {
    vi.stubEnv('SERVER_SMTP_ENABLED', 'false'); vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED', 'false');
    vi.stubEnv('MAILER_DATABASE_NAME', 'mailer_synthetic'); vi.stubEnv('DB_NAME', 'mailer_synthetic');
    const db = { $queryRaw: vi.fn(async () => [{ db: 'mailer_synthetic', activation: null, job: null, audit: null }]) };
    const providers = CORPORATE_DOCUMENT_PROVIDERS.map(provider => provider === PrismaService ? { provide: PrismaService, useValue: db } : provider);
    class Assembly {}
    Module({ controllers: CORPORATE_DOCUMENT_CONTROLLERS, providers })(Assembly);
    const app = await NestFactory.createApplicationContext(Assembly, { logger: false, abortOnError: false });
    try {
      expect(app.get(CorporateDocumentController)).toBeInstanceOf(CorporateDocumentController);
      expect(app.get(CorporateDocumentService)).toBeInstanceOf(CorporateDocumentService);
      expect(app.get(CorporateDocumentStore)).toBeInstanceOf(CorporateDocumentStore);
      expect(app.get(CorporateDocumentWorker)).toBeInstanceOf(CorporateDocumentWorker);
      expect(app.get(CorporateDocumentHealth).ready).toBe(false);
    } finally { await app.close(); }
  });
  it('HTTP mail-settings transporta Bearer/body/idempotencia y no-store al comando DOCUMENT', async () => {
    const service = { enqueue: vi.fn(async () => ({ id: randomUUID(), scope: 'DOCUMENT', state: 'QUEUED', deliveredToClient: false })),
      activate: vi.fn(async () => ({ scope: 'DOCUMENT', enabledForDocuments: true })), status: vi.fn(async () => ({ scope: 'DOCUMENT', readyToSendDocument: false })) };
    class Api {}
    Module({ controllers: [CorporateDocumentController], providers: [{ provide: CorporateDocumentService, useValue: service }] })(Api);
    const app = await NestFactory.create(Api, { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    try {
      const origin = 'http://127.0.0.1:' + app.getHttpServer().address().port, key = randomUUID(), documentId = randomUUID();
      const body = { documentId, expectedRevision: 1, expectedActivationRevision: 2, recipient: 'synthetic@example.invalid', format: 'a4', confirmed: true };
      const response = await fetch(origin + '/api/v1/mail-settings/1/send-document', { method: 'POST', headers: {
        Authorization: 'Bearer synthetic.document', 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
      expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ scope: 'DOCUMENT', deliveredToClient: false });
      expect(service.enqueue).toHaveBeenCalledWith('1', body, key, 'Bearer synthetic.document');
    } finally { app.getHttpServer().closeAllConnections(); await app.close(); }
  });
});
