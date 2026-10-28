import { hasActivation } from './authorization';
import { productionConnectors, type ReceptionConnectors } from './connectors';
import { AccessError } from '@factuez/service-access';
import { createHash } from 'node:crypto';
import type { Prisma, ReceptionConnection, ReceptionSyncRun } from '../generated/prisma/client';
import type { ReceivedSyncCounters } from '@factuez/contracts';
import { ReceptionPrisma } from '../prisma.service';
import { connectionSettings } from './service';
import { emptyCounters, fiscalAmountsMatch, receptionPeriods, receptionReadiness } from './policy';
import { ReceptionVault } from './vault';
import { fixtureMail } from './mail-fixture';
import { mailAttachments, mailboxFingerprint, visitMailbox, type MailMessage } from './mailbox';
import { prepareMailDocuments, importPreparedMail, type PreparedMail } from './importer';
import { SireReadClient } from './sire-client';
import { fixtureSirePurchases } from './sire-fixture';
import type { SirePurchase, SirePurchaseBatch } from './sire-client';
function nextReceptionPeriod(period:string) { const year=Number(period.slice(0,4)),month=Number(period.slice(4)); return month===12 ? String(year+1)+'01' : String(year)+String(month+1).padStart(2,'0'); }
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function sum(a: ReceivedSyncCounters, b: Partial<ReceivedSyncCounters>) { const c = { ...a }; for (const key of Object.keys(c) as (keyof ReceivedSyncCounters)[]) c[key] += b[key] ?? 0; return c; }
export async function assertConnection(tx: Prisma.TransactionClient, run: ReceptionSyncRun) {
  await tx.$queryRaw`SELECT "companyId" FROM "ReceptionConnection" WHERE "companyId" = ${run.companyId} FOR UPDATE`;
  const c = await tx.receptionConnection.findUnique({ where: { companyId: run.companyId } });
  const currentRun = await tx.receptionSyncRun.findUnique({ where: { id: run.id } });
  if (!c || !await hasActivation(tx,c) || !c.enabled || c.recipientRuc !== run.recipientRuc || c.revision !== run.revision || !currentRun || !['QUEUED', 'RUNNING'].includes(currentRun.status)) throw new AccessError(409, 'CONFIGURATION_CHANGED');
  return c;
}
export async function reconcilePurchases(tx: Prisma.TransactionClient, companyId: number, ruc: string, after?: string) {
  const purchases = await tx.receptionSirePurchase.findMany({ where: { companyId, recipientRuc: ruc, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 250 });
  const counters = { xmlPending: 0, matches: 0, mismatches: 0 };
  const documents = purchases.length ? await tx.receivedDocument.findMany({ where: { companyId, recipientRuc: ruc, OR: purchases.map(p => ({ supplierRuc: p.supplierRuc, documentType: p.documentType, series: p.series, number: p.number })) }, select: { id: true, supplierRuc: true, documentType: true, series: true, number: true, issueDate: true, currencyCode: true, payableAmount: true } }) : [];
  const key = (p: { supplierRuc: string; documentType: string; series: string; number: string }) => JSON.stringify([p.supplierRuc, p.documentType, p.series, p.number]);
  const byKey = new Map(documents.map(d => [key(d), d]));
  for (const p of purchases) {
    const doc = byKey.get(key(p));
    let xmlStatus = 'PENDING', documentId: string | null = null;
    if (doc) {
      documentId = doc.id;
      // Credit notes may be negative in RCE while the original UBL states a positive reduction.
      const amount = p.documentType === '07' && p.amount?.startsWith('-') ? p.amount.slice(1) : p.amount;
      xmlStatus = doc.issueDate.getTime() === p.issueDate.getTime() && p.currencyCode !== null && doc.currencyCode === p.currencyCode && fiscalAmountsMatch(doc.payableAmount, amount) ? 'MATCHED' : 'CONFLICT';
    }
    if (xmlStatus === 'PENDING') counters.xmlPending++; else if (xmlStatus === 'MATCHED') counters.matches++; else counters.mismatches++;
    if (p.xmlStatus !== xmlStatus || p.documentId !== documentId) await tx.receptionSirePurchase.update({ where: { id: p.id }, data: { xmlStatus, documentId } });
  }
  return { counters, next: purchases.length === 250 ? purchases[purchases.length - 1].id : undefined };
}
export class ReceptionSyncProcessor {
  private vault = new ReceptionVault();
  constructor(private readonly db: ReceptionPrisma, private readonly notify: (id: string) => Promise<void> = async () => {}, private readonly connectors: ReceptionConnectors = productionConnectors) {}
  async run(id: string) {
    const run = await this.db.receptionSyncRun.findUnique({ where: { id } });
    // B2B tasks have their own actor checks and atomic execution protocol.
    if (!run || run.activeKey?.startsWith('b2b/') || !['QUEUED', 'RUNNING'].includes(run.status)) return;
    const c = await this.db.$transaction(tx => assertConnection(tx, run)), settings = connectionSettings(c);
    const secrets = this.vault.open(c.encryptedCredentials, { companyId: c.companyId, ruc: c.recipientRuc, revision: c.revision });
    if (!['READY_LOCAL', 'READY_READ_ONLY'].includes(receptionReadiness(settings, c.recipientRuc, secrets)) || !(run.source === 'MAIL' ? settings.mailbox.enabled : settings.sire.enabled)) {
      await this.db.receptionSyncRun.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'BLOCKED', errorCode: 'CONNECTION_NOT_READY', activeKey: null, finishedAt: new Date() } }); return;
    }
    await this.db.receptionSyncRun.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date() } });
    if (run.source === 'MAIL') {
      const fingerprint = settings.mode === 'LOCAL_FIXTURE' ? `local-${settings.sire.startPeriod}` : mailboxFingerprint(settings.mailbox);
      const saved = await this.db.receptionMailboxCheckpoint.findUnique({ where: { companyId: c.companyId } });
      const checkpoint = saved?.fingerprint === fingerprint ? saved : null;
      const consume = async (m: MailMessage) => {
        let prepared: PreparedMail | null = null;
        if (m.raw) { try { prepared = prepareMailDocuments(await mailAttachments(m.raw), c.recipientRuc); } catch { /* Malformed messages are quarantined as metadata, not retried forever. */ } }
        const changed = await this.db.$transaction(async tx => {
          await assertConnection(tx, run);
          const key = { companyId: c.companyId, fingerprint, uidValidity: m.uidValidity, uid: BigInt(m.uid) };
          if (await tx.receptionMessageReceipt.findUnique({ where: { companyId_fingerprint_uidValidity_uid: key } })) return [];
          const result = prepared ? await importPreparedMail(tx, c, prepared, run.id) : { counts: { rejected: 1 }, changed: [] as string[] };
          await tx.receptionMessageReceipt.create({ data: { ...key, status: result.counts.rejected ? 'WITH_INCIDENTS' : 'PROCESSED', counts: json(result.counts) } });
          await tx.receptionMailboxCheckpoint.upsert({ where: { companyId: c.companyId }, create: { companyId: c.companyId, fingerprint, uidValidity: m.uidValidity, lastUid: BigInt(m.uid) }, update: { fingerprint, uidValidity: m.uidValidity, lastUid: BigInt(m.uid) } });
          const current = await tx.receptionSyncRun.findUniqueOrThrow({ where: { id } });
          await tx.receptionSyncRun.update({ where: { id }, data: { counters: json(sum(current.counters as unknown as ReceivedSyncCounters, { ...result.counts, detected: 1 })) } });
          return result.changed;
        }, { timeout: 30000 });
        for (const doc of changed) { try { await this.notify(doc); } catch { /* Durable import must not fail on realtime delivery. */ } }
      };
      if (settings.mode === 'LOCAL_FIXTURE') {
        if (!checkpoint || checkpoint.uidValidity !== '1' || checkpoint.lastUid < 1n) {
          const raw = fixtureMail(c.recipientRuc, settings.sire.startPeriod);
          try { await consume({ uid: 1, uidValidity: '1', raw }); } finally { raw.fill(0); }
        }
      } else {
        const cursor = await this.connectors.mailbox(settings.mailbox, secrets.mailPassword, checkpoint, consume, process.env.RECEIVED_LIVE_READ_ALLOWED === 'true');
        await this.db.$transaction(async tx => { await assertConnection(tx, run); await tx.receptionMailboxCheckpoint.upsert({ where: { companyId: c.companyId }, create: { companyId: c.companyId, fingerprint, uidValidity: cursor.uidValidity, lastUid: BigInt(cursor.lastUid) }, update: { fingerprint, uidValidity: cursor.uidValidity, lastUid: BigInt(cursor.lastUid) } }); });
      }
    } else if (run.source === 'SIRE') {
      const client = settings.mode === 'LIVE_READ_ONLY' ? this.connectors.sire({ ruc: c.recipientRuc, clientId: settings.sire.clientId, clientSecret: secrets.sireClientSecret,
        solUsername: settings.sire.solUsername, solPassword: secrets.solPassword }) : null;
      const periods = receptionPeriods(settings.sire.startPeriod);
      let backfill: string | undefined;
      if (client) {
        // One historical period per run, plus the rolling late-report window.
        // Audit cursor is revision-bound and advances only after all rows commit.
        const cursor=await this.db.receptionConnectionAudit.findFirst({where:{companyId:run.companyId,revision:run.revision,action:'SIRE_BACKFILL_COMPLETED'},orderBy:{createdAt:'desc'}});
        const last=(cursor?.detail as {period?:string}|undefined)?.period;
        const historical=last && /^20\d{2}(0[1-9]|1[0-2])$/.test(last) ? nextReceptionPeriod(last) : settings.sire.startPeriod;
        if(historical<periods[0]){backfill=historical;periods.unshift(historical);}
      }
      for (const period of periods) {
        const previous = client ? await this.db.receptionConnectionAudit.findFirst({ where: { companyId:run.companyId, revision:run.revision, action: {in:['SIRE_TICKET_CREATED','SIRE_PERIOD_COMPLETED']}, detail:{path:['period'],equals:period} }, orderBy:[{createdAt:'desc'},{id:'desc'}] }) : null;
        const detail = previous?.detail as {ticket?:string;runId?:string}|undefined;
        if (previous?.action==='SIRE_PERIOD_COMPLETED' && detail?.runId===run.id) continue;
        const checkpoint = {
          ticket: previous?.action==='SIRE_TICKET_CREATED' ? detail?.ticket : undefined,
          beforeRequest: async () => { await this.db.$transaction(tx => assertConnection(tx,run)); },
          saveTicket: async (ticket:string) => { await this.db.$transaction(async tx => { await assertConnection(tx,run); await tx.receptionConnectionAudit.create({data:{companyId:run.companyId,revision:run.revision,actorId:c.configuredBy,action:'SIRE_TICKET_CREATED',detail:{recipientRuc:run.recipientRuc,period,ticket,runId:run.id}}}); }); },
        };
        const batch = client ? await client.readPeriodDetailed(period,checkpoint) : { purchases: fixtureSirePurchases(c.recipientRuc, period), incidents: [] };
        await this.persistPurchases(run, period, batch);
        if (client) await this.db.$transaction(async tx => {
          await assertConnection(tx,run);
          const data={companyId:run.companyId,revision:run.revision,actorId:c.configuredBy,detail:{recipientRuc:run.recipientRuc,period,runId:run.id}};
          await tx.receptionConnectionAudit.create({data:{...data,action:'SIRE_PERIOD_COMPLETED'}});
          if(period===backfill)await tx.receptionConnectionAudit.create({data:{...data,action:'SIRE_BACKFILL_COMPLETED'}});
        });
      }
    } else throw new AccessError(400, 'SYNC_SOURCE_INVALID');
    let after: string | undefined;
    const totals = { xmlPending: 0, matches: 0, mismatches: 0 };
    do {
      const page = await this.db.$transaction(async tx => { await assertConnection(tx, run); return reconcilePurchases(tx, c.companyId, c.recipientRuc, after); }, { timeout: 30000 });
      totals.xmlPending += page.counters.xmlPending; totals.matches += page.counters.matches; totals.mismatches += page.counters.mismatches; after = page.next;
    } while (after);
    await this.db.$transaction(async tx => {
      await assertConnection(tx, run);
      const current = await tx.receptionSyncRun.findUniqueOrThrow({ where: { id } });
      await tx.receptionSyncRun.update({ where: { id }, data: { status: 'COMPLETED', activeKey: null, finishedAt: new Date(), errorCode: null, counters: json({ ...(current.counters as unknown as ReceivedSyncCounters), ...totals }) } });
    }, { timeout: 30000 });
  }
  private async persistPurchases(run: ReceptionSyncRun, period: string, batch: SirePurchaseBatch) {
    const rows = batch.purchases;
    if (rows.length + batch.incidents.length > 20000) throw new AccessError(400, 'SIRE_PURCHASE_LIMIT');
    for (const p of rows) {
      if (p.recipientRuc !== run.recipientRuc || p.period !== period || !/^\d{11}$/.test(p.supplierRuc) || !/^[A-Z0-9]{2}$/.test(p.documentType) || !/^[A-Za-z0-9]{1,20}$/.test(p.series) || !/^[A-Za-z0-9]{1,20}$/.test(p.number)) throw new AccessError(400, 'SIRE_RECIPIENT_MISMATCH');
    }
    for (let offset = 0; offset < rows.length; offset += 250) await this.db.$transaction(async tx => {
      await assertConnection(tx, run);
      for (const p of rows.slice(offset, offset + 250)) {
        const key = { recipientRuc: p.recipientRuc, supplierRuc: p.supplierRuc, documentType: p.documentType, series: p.series, number: /^\d+$/.test(p.number) ? BigInt(p.number).toString() : p.number, period: p.period };
        const data = { supplierName: p.supplierName, fullNumber: p.fullNumber, issueDate: new Date(p.issueDate + 'T00:00:00Z'), currencyCode: p.currencyCode, amount: p.amount, rawRecord: json(p.rawRecord), observedAt: new Date(), observedRunId: run.id };
        await tx.receptionSirePurchase.upsert({ where: { recipientRuc_supplierRuc_documentType_series_number_period: key }, create: { ...key, ...data, companyId: run.companyId, xmlStatus: 'PENDING' }, update: data });
      }
    }, { timeout: 30000 });
    for (let offset = 0; offset < batch.incidents.length; offset += 250) await this.db.$transaction(async tx => {
      await assertConnection(tx, run);
      for (const issue of batch.incidents.slice(offset, offset + 250)) {
        const recordHash = createHash('sha256').update(JSON.stringify(issue.rawRecord)).digest('hex');
        const key = { companyId: run.companyId, period, recordHash };
        const data = { recipientRuc: run.recipientRuc, code: issue.code, ordinal: issue.ordinal, rawRecord: json(issue.rawRecord), active: true, observedAt: new Date(), observedRunId: run.id };
        await tx.receptionSireIncident.upsert({ where: { companyId_period_recordHash: key }, create: { ...key, ...data }, update: data });
      }
    }, { timeout: 30000 });
    await this.db.$transaction(async tx => {
      await assertConnection(tx, run);
      await tx.receptionSireIncident.updateMany({ where: { companyId: run.companyId, recipientRuc: run.recipientRuc, period, observedRunId: { not: run.id }, active: true }, data: { active: false } });
      const detected = await tx.receptionSirePurchase.count({ where: { companyId: run.companyId, recipientRuc: run.recipientRuc, observedRunId: run.id } });
      const rejected = await tx.receptionSireIncident.count({ where: { companyId: run.companyId, recipientRuc: run.recipientRuc, observedRunId: run.id } });
      const current = await tx.receptionSyncRun.findUniqueOrThrow({ where: { id: run.id } });
      await tx.receptionSyncRun.update({ where: { id: run.id }, data: { counters: json({ ...(current.counters as unknown as ReceivedSyncCounters), detected: detected + rejected, rejected }) } });
    }, { timeout: 30000 });
  }
}
