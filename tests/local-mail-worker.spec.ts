import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const mocks = vi.hoisted(() => ({ sendMail: vi.fn(), bytes: Buffer.from('PDF QA fixture'), corrupt: false }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), realpath: async (path: string) => resolve(path), readFile: async () => mocks.corrupt ? Buffer.from('ALTERADO') : mocks.bytes }));
import { LocalMail } from '../services/mailer-worker/src/local-mail';
import type { PrismaService } from '../services/mailer-worker/src/prisma.service';
import { LocalCaptureSmtp, LOCAL_CAPTURE_SMTP_OPTIONS } from '../services/mailer-worker/src/capture-smtp';
const id = '160250d9-160a-436a-aa32-90f6b996badd';
const fileId = '978c5eba-4447-41db-a0c5-c6cce26b1896';
const digest = createHash('sha256').update(mocks.bytes).digest('hex');
const base = { id, documentId: id, actorId: id, status: 'QUEUED', attempt: 0, recipient: 'cliente@pruebas.invalid',
  manifest: { subject: 'PRUEBA SIN VALIDEZ', attachments: [
    { key: `${id}/${fileId}`, filename: 'PRUEBA-SIMULADO.pdf', type: 'application/pdf', size: mocks.bytes.length, sha256: digest },
    { key: `${id}/${fileId}`, filename: 'XML-CDR-SIMULADO.zip', type: 'application/zip', size: mocks.bytes.length, sha256: digest },
  ] } };
function service(row = base, claim = 1) {
  const prisma = { localQaMail: { findUnique: vi.fn().mockResolvedValue(row), updateMany: vi.fn().mockResolvedValue({count:claim}) } };
  return { mail: new LocalMail(prisma as unknown as PrismaService, {capture:mocks.sendMail} as LocalCaptureSmtp), prisma };
}
beforeEach(() => {
  vi.stubEnv('LOCAL_MAIL_QA_ENABLED','true'); vi.stubEnv('WORKSPACE_LIVE_ENABLED','false');
  vi.clearAllMocks(); mocks.corrupt = false; mocks.sendMail.mockReset().mockResolvedValue({messageId:'captura@factuez.invalid'});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('worker de correo local y resultados inciertos', () => {
  it('envía sólo al capturador fijado, sin acceso a URLs/archivos SMTP ni secretos', async () => {
    const {mail,prisma} = service(); await mail.process(id);
    expect(LOCAL_CAPTURE_SMTP_OPTIONS).toMatchObject({host:'mailpit',port:1025,disableFileAccess:true,disableUrlAccess:true});
    const message = mocks.sendMail.mock.calls[0][0]; expect(message.to).toBe('cliente@pruebas.invalid'); expect(message.attachments).toHaveLength(2);
    expect(message.text).toContain('CDR simulado, NO oficial'); expect(JSON.stringify(message)).not.toContain('Bearer');
    expect(prisma.localQaMail.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({status:'CAPTURED_LOCAL'})}));
  });
  it('no vuelve a procesar una captura terminada', async () => { const {mail} = service({...base,status:'CAPTURED_LOCAL'}); await mail.process(id); expect(mocks.sendMail).not.toHaveBeenCalled(); });
  it('sólo el worker que obtiene el claim atómico envía', async () => { const {mail} = service(base,0); await mail.process(id); expect(mocks.sendMail).not.toHaveBeenCalled(); });
  it('archivo alterado queda FAILED y no llega a SMTP', async () => {
    mocks.corrupt=true; const {mail,prisma}=service(); await mail.process(id); expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(prisma.localQaMail.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({status:'FAILED'})}));
  });
  it('dominio real queda FAILED antes de intentar SMTP', async () => { const {mail,prisma}=service({...base,recipient:'cliente@real.pe'}); await mail.process(id); expect(mocks.sendMail).not.toHaveBeenCalled(); expect(prisma.localQaMail.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({status:'FAILED'})})); });
  it('sólo falla de conexión inequívoca permite reintento', async () => {
    mocks.sendMail.mockRejectedValue({command:'CONN',code:'ECONNREFUSED'}); const {mail,prisma}=service(); await mail.process(id);
    expect(prisma.localQaMail.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({status:'RETRYABLE_ERROR'})}));
  });
  it('respuesta perdida después de DATA queda UNKNOWN sin reenvío', async () => {
    mocks.sendMail.mockRejectedValue({command:'DATA',code:'ETIMEDOUT'}); const {mail,prisma}=service(); await mail.process(id);
    expect(prisma.localQaMail.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({status:'UNKNOWN'})})); expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });
  it('no hace un cuarto intento tras agotar el límite local', async () => {
    mocks.sendMail.mockRejectedValue({command:'CONN',code:'ECONNREFUSED'}); const {mail,prisma}=service({...base,attempt:2}); await mail.process(id);
    expect(prisma.localQaMail.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({status:'UNKNOWN'})}));
  });
});
