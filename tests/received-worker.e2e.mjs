// Exercises the deployed scheduler + BullMQ + worker, isolated fake recipient.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
if (!process.argv.includes('--isolated-synthetic-only') || process.env.DB_HOST !== 'received-postgres' || process.env.DB_NAME !== 'factuez_received_qa' || process.env.RECEIVED_LIVE_READ_ALLOWED !== 'false' || process.env.DATABASE_URL)
  throw new Error('Requiere recepción QA aislada, sin lectura real');
const require = createRequire(new URL('../services/received-documents-service/package.json', import.meta.url));
const { ReceptionPrisma } = require('./dist/prisma.service.js');
const { defaultReceptionSettings } = require('./dist/automation/policy.js');
const { createSyncRun } = require('./dist/automation/service.js');
const seed = Date.now() % 700000000, companyId = 1000000000 + seed, recipientRuc = `00${String(seed).padStart(9, '0')}`;
const db = new ReceptionPrisma(); await db.$connect(); let checks = 0;
const check = (a, b) => { assert.deepEqual(a, b); checks++; };
const defaults = defaultReceptionSettings();
const settings = { ...defaults, enabled: true, mode: 'LOCAL_FIXTURE', mailbox: { ...defaults.mailbox, enabled: true }, sire: { ...defaults.sire, enabled: true } };
async function finished(ids) {
  const until = Date.now() + 90000;
  for (;;) {
    const rows = await db.receptionSyncRun.findMany({ where: { companyId, ...(ids ? { id: { in: ids } } : {}) }, orderBy: { createdAt: 'desc' } });
    if (rows.length >= 2 && rows.every(r => r.status === 'COMPLETED')) return rows;
    if (rows.some(r => ['FAILED', 'BLOCKED'].includes(r.status))) throw new Error('Fallo de worker ficticio');
    if (Date.now() > until) throw new Error('Timeout del worker ficticio');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
try {
  await db.receptionConnection.create({ data: { companyId, recipientRuc, configuredBy: randomUUID(), enabled: true, mode: settings.mode, revision: 1, settings } });
  const first = await finished(); check(first.length, 2); check(first.every(r => r.status === 'COMPLETED'), true);
  check(await db.receivedDocument.count({ where: { companyId, recipientRuc } }), 1);
  check(await db.receptionMessageReceipt.count({ where: { companyId } }), 1);
  check(await db.receptionSirePurchase.count({ where: { companyId, recipientRuc, xmlStatus: 'MATCHED' } }), 1);
  const doc = await db.receivedDocument.findFirstOrThrow({ where: { companyId, recipientRuc } }); check(doc.branchId, null);
  check(await db.receivedItemRecord.count({ where: { documentId: doc.id } }), 1);
  const next = await Promise.all(['MAIL', 'SIRE'].map(source => createSyncRun(db, companyId, recipientRuc, 1, source)));
  const second = await finished(next.map(r => r.id)); check(second.length, 2);
  check(await db.receivedDocument.count({ where: { companyId, recipientRuc } }), 1); check(await db.receptionMessageReceipt.count({ where: { companyId } }), 1);
  check(await db.receptionSirePurchase.count({ where: { companyId, recipientRuc } }), 1);
  check(await db.receptionSyncRun.count({ where: { companyId, activeKey: { not: null } } }), 0);
  console.log(JSON.stringify({ status: 'PASS', checks, scheduler: true, bullmq: true, syntheticOnly: true, officialRequests: 0, realMailboxRequests: 0 }));
} finally {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "companyId" FROM "ReceptionConnection" WHERE "companyId" = ${companyId} FOR UPDATE`;
    await tx.receptionConnection.updateMany({ where: { companyId, recipientRuc }, data: { enabled: false, settings: { ...settings, enabled: false } } });
    await tx.receptionSyncRun.updateMany({ where: { companyId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'BLOCKED', activeKey: null, errorCode: 'QA_FINISHED', finishedAt: new Date() } });
  }); await db.$disconnect();
}
