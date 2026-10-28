import { randomUUID } from 'node:crypto';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { buildFiscalBatchUbl } from '@factuez/sunat-core/dist/fiscal-batch';
import { fiscalSnapshotSha256 as hash, validateFiscalAcceptance, validateFiscalOriginal,
  validateFiscalNoteSnapshot, type FiscalNoteSnapshot } from '@factuez/sunat-core/dist/fiscal-note';
import { boundedSupplementJson, validateFiscalSupplementCommand } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type { BatchJournal, BatchMemberBinding, BatchMemberGrant, BatchMemberOwnerPort, BatchMemberPlan,
  BatchMemberTransaction, BatchMemberVersion, BatchOwnerMember, BatchPrepared, BatchScope, BatchSubject, BatchMemberRequest } from './batch-member-authority';
import type { BatchLocalGrantPolicy, BatchLocalProducerTransaction, BatchMemberEvidencePort,
  BatchMemberIdentityPort, BatchMemberPolicyAdminPort, BatchSqlConnection, BatchSqlPool } from './batch-member-postgres.types';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code = 'INVALID_BATCH_OWNER'): never { throw new B2bSecurityError(409, code); }
const safeCodes = new Set(['INVALID_BATCH_OWNER', 'BATCH_MEMBER_DENIED', 'BATCH_MEMBER_CHANGED', 'BATCH_AUTHORITY_CHANGED',
  'BATCH_EXPIRED', 'BATCH_PLAN_REQUIRED', 'BATCH_CALLBACK_CLOSED', 'BATCH_CALLBACK_REENTRY', 'BATCH_REUSE_REQUIRED',
  'BATCH_JOURNAL_MISSING', 'BATCH_JOURNAL_CONFLICT', 'BATCH_OWNER_UNAVAILABLE', 'BATCH_CORE_REJECTED']);
function sanitized(error: unknown): never {
  if (error instanceof B2bSecurityError && safeCodes.has(error.code)) throw error;
  throw new B2bSecurityError(503, 'BATCH_OWNER_UNAVAILABLE');
}
const json = <T>(value: T): T => boundedSupplementJson(value) as T;
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
const key = (member: BatchMemberVersion) => `${member.documentId}/${member.version}`;
const grantKey = (subject: BatchSubject, binding: BatchMemberBinding, kind: 'RC' | 'RA', permission: 'READ' | 'WRITE') =>
  hash({ subject, binding, kind, permission });
const journalKey = (subject: BatchSubject, scope: BatchScope, idempotencyKey: string) => hash({ subject, scope, idempotencyKey });
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
function actor(value: BatchSubject): void {
  if (!value || Object.keys(value).sort().join(',') !== 'clientId,kind,subjectId' || !UUID.test(value.clientId) ||
    !(value.kind === 'SERVICE' && value.subjectId === null || value.kind === 'USER' && UUID.test(value.subjectId ?? ''))) fail();
}
function binding(value: BatchMemberBinding): void {
  if (!value || Object.keys(value).sort().join(',') !== 'branchId,companyId,documentType,environment,issuerRuc,pointId,series,seriesId' ||
    value.environment !== 'BETA' || !positive(value.companyId) || !/^\d{11}$/.test(value.issuerRuc) ||
    ![value.branchId, value.pointId, value.seriesId].every(v => UUID.test(v)) ||
    !/^[BF][A-Z0-9]{3}$/.test(value.series) || !['01', '03', '07', '08'].includes(value.documentType)) fail();
}
function fresh(checkedAt: string, now: string): void {
  const age = Date.parse(now) - Date.parse(checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30000) fail('BATCH_EXPIRED');
}
function immutableIdentity(snapshot: BatchOwnerMember['snapshot'], tuple: BatchMemberBinding) {
  return { binding: tuple, documentId: snapshot.documentId, documentTypeCode: snapshot.documentTypeCode,
    series: snapshot.series, number: snapshot.number, fullNumber: snapshot.fullNumber, issueDate: snapshot.issueDate,
    issuer: snapshot.issuer, customer: snapshot.customer, environment: snapshot.environment,
    companyId: snapshot.companyId, branchId: snapshot.branchId, currencyCode: snapshot.currencyCode,
    operationTypeCode: snapshot.operationTypeCode, ...('reference' in snapshot ? { reference: snapshot.reference } : {}) };
}
type StoredVersion = Pick<BatchOwnerMember, 'member' | 'binding' | 'snapshot' | 'acceptance' | 'notDelivered' | 'note'>;

/** Durable LOCAL BETA owner. Every writer in this aggregate uses the same PostgreSQL session
 * advisory lock BEFORE BEGIN, then the mutex row and sorted member/grant FOR UPDATE locks.
 * Taking the session lock before the SERIALIZABLE snapshot avoids stale queued snapshots.
 * This deliberately serializes this small candidate aggregate, including local revocation and
 * credit admission. No retry invokes the coordinator callback a second time.
 * Direct SQL writers outside this protocol are not supported; production roles are not installed.
 * Identity remains remote: final fresh lookup fences the observed revisions but cannot make a
 * concurrent remote revoke atomic with this commit. No distributed revocation protocol is claimed. */
export class PostgresBatchMemberOwner implements BatchMemberOwnerPort<BatchLocalProducerTransaction> {
  constructor(private readonly pool: BatchSqlPool, private readonly evidence: BatchMemberEvidencePort,
    private readonly identity: BatchMemberIdentityPort, private readonly policyAdmin: BatchMemberPolicyAdminPort,
    private readonly now = () => new Date().toISOString()) {}

  /** Private lookup by the immutable batch ID + exact owner subject/scope. This
   * reveals no command to a public caller: HTTP authenticates first and then
   * reauthorizes/fences the entire member closure before returning artifacts.
   * No MAX/latest version inference, counter reservation or new journal write. */
  async loadArtifactRequest(scope: BatchScope & { batchId: string }, subject: BatchSubject): Promise<BatchMemberRequest | null> {
    const s = json(scope), who = json(subject); actor(who);
    if (!s || Object.keys(s).sort().join(',') !== 'batchId,branchId,companyId,environment,issuerRuc' ||
      s.environment !== 'BETA' || !positive(s.companyId) || !/^\d{11}$/.test(s.issuerRuc) ||
      !UUID.test(s.branchId) || !UUID.test(s.batchId)) fail();
    const { batchId, ...tuple } = s;
    return this.locked(async db => {
      const row = (await db.query(`SELECT request,request_sha256,command,command_sha256,subject
        FROM b2b_batch_member_command WHERE batch_id=$1 AND subject=$2::jsonb AND request->'scope'=$3::jsonb`,
      [batchId, JSON.stringify(who), JSON.stringify(tuple)])).rows[0];
      if (!row) return null;
      const request = json(row.request) as BatchMemberRequest;
      const command = validateFiscalSupplementCommand(row.command), envelope = command.payload.envelope;
      if (!equal(row.subject, who) || !equal(request.scope, tuple) ||
        row.request_sha256 !== hash({ ...request, asOf: null, subject: who }) ||
        row.command_sha256 !== hash(command) || envelope.kind !== 'BATCH' ||
        envelope.batch.documentId !== batchId || envelope.batch.kind !== request.kind ||
        envelope.batch.issueDate !== request.issueDate || envelope.batch.referenceDate !== request.referenceDate)
        fail('BATCH_JOURNAL_CONFLICT');
      return request;
    });
  }

  private async locked<T>(work: (db: BatchSqlConnection) => Promise<T>): Promise<T> {
    let db: BatchSqlConnection;
    try { db = await this.pool.connect(); } catch (error) { return sanitized(error); }
    let locked = false, begun = false, destroyConnection = false;
    try {
      await db.query('SELECT pg_advisory_lock(2070707)'); locked = true;
      await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); begun = true;
      await db.query('SELECT id FROM b2b_batch_member_mutex WHERE id=1 FOR UPDATE');
      const result = await work(db);
      await db.query('COMMIT'); begun = false; return result;
    } catch (error) {
      if (begun) { try { await db.query('ROLLBACK'); } catch { destroyConnection = true; } }
      return sanitized(error);
    } finally {
      try { if (locked) await db.query('SELECT pg_advisory_unlock(2070707)'); }
      catch (error) { destroyConnection = true; sanitized(error); }
      finally { db.release(destroyConnection); }
    }
  }

  /** Private import accepts only an owner handle. Version/identity/acceptance/history are owned
   * here or returned by the explicitly injected verifier; never supplied by a public request.
   * The verifier's complete catalogue digest must match all locally admitted accepted/reserved
   * credits. A missing foreign credit fails closed rather than manufacturing complete:true. */
  async importVerifiedVersion(ownerHandle: string): Promise<BatchMemberVersion> {
    if (typeof ownerHandle !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(ownerHandle)) fail();
    return this.locked(async db => {
      const asOf = this.now(), v = json(await this.evidence.verifySignedVersion(ownerHandle, asOf));
      const s = v.snapshot, b = v.binding, p = v.provenance;
      binding(b);
      if (!p || Object.keys(p).sort().join(',') !== 'artifactId,catalogueSha256,cdrSha256,signedXmlSha256,verifiedAt,verifierId' ||
        !/^[A-Za-z0-9._:-]{1,200}$/.test(p.verifierId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(p.artifactId) ||
        !HASH.test(p.signedXmlSha256) || !HASH.test(p.catalogueSha256) || !UUID.test(s.documentId) ||
        s.environment !== 'BETA' || s.companyId !== b.companyId || s.branchId !== b.branchId ||
        s.issuer.identityNumber !== b.issuerRuc || s.series !== b.series || s.documentTypeCode !== b.documentType) fail();
      fresh(p.verifiedAt, this.now());
      if (v.acceptance) {
        validateFiscalAcceptance(s, v.acceptance, asOf);
        if (v.acceptance.cdrSha256 !== p.cdrSha256 || !HASH.test(p.cdrSha256 ?? '')) fail();
      } else if (p.cdrSha256 !== null) fail();
      if (v.notDelivered) {
        const e = v.notDelivered;
        if (e.status !== 'NOT_DELIVERED' || e.documentId !== s.documentId || e.snapshotSha256 !== hash(s) ||
          e.documentTypeCode !== s.documentTypeCode || e.fullNumber !== s.fullNumber || e.issuerRuc !== b.issuerRuc ||
          !UUID.test(e.evidenceId) || !Number.isFinite(Date.parse(e.assertedAt)) ||
          Date.parse(e.assertedAt) < Date.parse(s.issueDate) || Date.parse(e.assertedAt) > Date.parse(asOf)) fail();
      }
      // A signed XML artifact may first have no CDR, then gain a verified acceptance. Both are
      // immutable owner versions. Replay identity binds the entire admission, excluding freshness.
      const { verifiedAt: _verifiedAt, ...proof } = p;
      const admission = hash({ binding: b, snapshot: s, acceptance: v.acceptance, notDelivered: v.notDelivered, original: v.original, proof });
      const reusedXml = (await db.query(`SELECT record,record_sha256,provenance FROM b2b_batch_member_version
        WHERE provenance->>'verifierId'=$1 AND provenance->>'artifactId'=$2 LIMIT 1`, [p.verifierId, p.artifactId])).rows[0];
      if (reusedXml) {
        const prior = this.stored(reusedXml);
        if (!equal(prior.snapshot, s) || !equal(prior.binding, b) || reusedXml.provenance.signedXmlSha256 !== p.signedXmlSha256) fail();
      }
      const artifact = (await db.query(`SELECT record,record_sha256,provenance FROM b2b_batch_member_version
        WHERE admission_sha256=$1`, [admission])).rows[0];
      if (artifact) {
        const old = this.stored(artifact);
        const { verifiedAt: _oldTime, ...oldProof } = artifact.provenance;
        const { verifiedAt: _newTime, ...newProof } = p;
        if (!equal({ binding: old.binding, snapshot: old.snapshot, acceptance: old.acceptance, notDelivered: old.notDelivered,
          original: old.note?.original ?? null }, { binding: b, snapshot: s, acceptance: v.acceptance, notDelivered: v.notDelivered, original: v.original }) ||
          !equal(oldProof, newProof)) fail();
        return old.member;
      }
      const head = (await db.query(`SELECT current_version,identity_sha256 FROM b2b_batch_member_document
        WHERE document_id=$1 FOR UPDATE`, [s.documentId])).rows[0];
      const identitySha = hash(immutableIdentity(s, b));
      if (head && head.identity_sha256 !== identitySha) fail('BATCH_MEMBER_CHANGED');
      let note: StoredVersion['note'] = null;
      if (s.documentTypeCode === '07' || s.documentTypeCode === '08') {
        if (!v.original) fail();
        const original = await this.readMember(db, v.original);
        if (!original || !original.acceptance || !['01', '03'].includes(original.binding.documentType)) fail();
        const history = await this.creditCatalogue(db, v.original.documentId, s.documentId);
        if (history.length > 99 || hash(history) !== p.catalogueSha256) fail('BATCH_MEMBER_CHANGED');
        const entries = [];
        for (const h of history) {
          const prior = await this.readMember(db, h.member);
          if (!prior || h.state === 'ACCEPTED' && !prior.acceptance) fail();
          entries.push({ state: h.state, note: prior.snapshot as FiscalNoteSnapshot });
        }
        validateFiscalNoteSnapshot(s as FiscalNoteSnapshot, { original: original.snapshot as Parameters<typeof validateFiscalOriginal>[0],
          acceptance: original.acceptance, asOf, creditHistory: { complete: true, entries } });
        note = { original: v.original, historyRevision: original.revision, creditHistory: history };
      } else {
        if (v.original !== null || p.catalogueSha256 !== hash([])) fail();
        validateFiscalOriginal(s, asOf);
      }
      const member = { documentId: s.documentId, version: head ? head.current_version + 1 : 1, snapshotSha256: hash(s) };
      const record: StoredVersion = json({ member, binding: b, snapshot: s, acceptance: v.acceptance, notDelivered: v.notDelivered, note });
      if (head) await db.query('UPDATE b2b_batch_member_document SET current_version=current_version+1,revision=revision+1 WHERE document_id=$1', [s.documentId]);
      else await db.query(`INSERT INTO b2b_batch_member_document(document_id,binding,identity_sha256,fiscal_identity,current_version,revision)
        VALUES($1,$2::jsonb,$3,$4,1,1)`, [s.documentId, JSON.stringify(b), identitySha, `${b.issuerRuc}/${b.documentType}/${s.fullNumber}`]);
      await db.query(`INSERT INTO b2b_batch_member_version(document_id,version,snapshot_sha256,record,record_sha256,provenance,admission_sha256)
        VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)`, [member.documentId, member.version, member.snapshotSha256,
        JSON.stringify(record), hash(record), JSON.stringify(p), admission]);
      if (!note && !head) await db.query('INSERT INTO b2b_batch_member_history(original_id,revision) VALUES($1,1)', [s.documentId]);
      if (note) await db.query('UPDATE b2b_batch_member_history SET revision=revision+1 WHERE original_id=$1', [note.original.documentId]);
      return member;
    });
  }

  async setLocalGrant(ownerAdminHandle: string, value: BatchLocalGrantPolicy): Promise<number> {
    try { return await this.setAuthorizedGrant(ownerAdminHandle, value); } catch (error) { return sanitized(error); }
  }
  private async setAuthorizedGrant(ownerAdminHandle: string, value: BatchLocalGrantPolicy): Promise<number> {
    if (typeof ownerAdminHandle !== 'string' || !ownerAdminHandle || ownerAdminHandle.length > 4096) fail('BATCH_MEMBER_DENIED');
    const p = json(value); actor(p.subject); binding(p.binding);
    if (Object.keys(p).sort().join(',') !== 'active,binding,clientRevision,expectedRevision,kind,permission,subject,userAuthRevision' ||
      !['RC', 'RA'].includes(p.kind) || !['READ', 'WRITE'].includes(p.permission) || !positive(p.clientRevision) ||
      typeof p.active !== 'boolean' || !Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0 ||
      !(p.subject.kind === 'SERVICE' ? p.userAuthRevision === null : Number.isSafeInteger(p.userAuthRevision) && Number(p.userAuthRevision) >= 0)) fail();
    const digest = hash(p);
    const authorize = async () => {
      const receipt = json(await this.policyAdmin.authorizeStepUp(ownerAdminHandle, digest, this.now()));
      if (!receipt || !UUID.test(receipt.adminId) || !positive(receipt.authRevision) || receipt.policySha256 !== digest) fail('BATCH_MEMBER_DENIED');
      fresh(receipt.checkedAt, this.now());
      const { checkedAt: _, ...mark } = receipt; return mark;
    };
    const before = await authorize();
    return this.locked(async db => {
      if (!equal(before, await authorize())) fail('BATCH_AUTHORITY_CHANGED');
      const k = grantKey(p.subject, p.binding, p.kind, p.permission);
      const old = (await db.query('SELECT revision FROM b2b_batch_member_grant WHERE grant_key=$1 FOR UPDATE', [k])).rows[0];
      if ((old?.revision ?? 0) !== p.expectedRevision) fail('BATCH_AUTHORITY_CHANGED');
      const revision = p.expectedRevision + 1, { expectedRevision: _, ...policy } = p;
      if (old) await db.query('UPDATE b2b_batch_member_grant SET policy=$2::jsonb,revision=$3 WHERE grant_key=$1', [k, JSON.stringify(policy), revision]);
      else await db.query('INSERT INTO b2b_batch_member_grant(grant_key,policy,revision) VALUES($1,$2::jsonb,$3)', [k, JSON.stringify(policy), revision]);
      if (!equal(before, await authorize())) fail('BATCH_AUTHORITY_CHANGED');
      return revision;
    });
  }

  private stored(row: { record: StoredVersion; record_sha256: string }): StoredVersion {
    const r = json(row.record);
    if (hash(r) !== row.record_sha256 || hash(r.snapshot) !== r.member.snapshotSha256) fail();
    return r;
  }
  private async readMember(db: BatchSqlConnection, ref: BatchMemberVersion): Promise<BatchOwnerMember | null> {
    const row = (await db.query(`SELECT v.record,v.record_sha256,v.provenance,d.current_version,d.revision,d.binding,
      coalesce(h.revision,1) AS history_revision
      FROM b2b_batch_member_version v JOIN b2b_batch_member_document d USING(document_id)
      LEFT JOIN b2b_batch_member_history h ON h.original_id=CASE WHEN v.record->'note' = 'null'::jsonb
        THEN d.document_id ELSE (v.record->'note'->'original'->>'documentId')::uuid END
      WHERE v.document_id=$1 AND v.version=$2`, [ref.documentId, ref.version])).rows[0];
    if (!row) return null;
    const r = this.stored(row);
    if (!equal(r.member, ref) || !equal(r.binding, row.binding) || !HASH.test(row.provenance?.signedXmlSha256 ?? '') ||
      r.acceptance && r.acceptance.cdrSha256 !== row.provenance.cdrSha256) fail('BATCH_MEMBER_CHANGED');
    const accepted = (await db.query(`SELECT 1 FROM b2b_batch_member_version WHERE document_id=$1 AND version<=$2
      AND record->'acceptance' <> 'null'::jsonb LIMIT 1`, [ref.documentId, ref.version])).rows.length > 0;
    return json({ ...r, note: r.note ? { ...r.note, historyRevision: row.history_revision } : null,
      revision: row.revision + row.history_revision - 1, lifecycle: row.current_version === ref.version ? 'CURRENT' : 'HISTORICAL',
      reporting: accepted ? 'REPORTED' : 'UNREPORTED' });
  }
  private async creditCatalogue(db: BatchSqlConnection, originalId: string, excludeId?: string) {
    const rows = (await db.query(`SELECT v.record,v.record_sha256 FROM b2b_batch_member_document d
      JOIN b2b_batch_member_version v ON v.document_id=d.document_id AND v.version=d.current_version
      WHERE v.record->'note'->'original'->>'documentId'=$1 AND v.record->'binding'->>'documentType'='07'
      AND ($2::text IS NULL OR d.document_id::text<>$2) ORDER BY d.document_id LIMIT 101`, [originalId, excludeId ?? null])).rows;
    if (rows.length > 100) fail();
    return rows.map(row => { const r = this.stored(row); return { member: r.member, state: r.acceptance ? 'ACCEPTED' as const : 'RESERVED' as const }; });
  }
  member(ref: BatchMemberVersion): Promise<BatchOwnerMember | null> { return this.locked(db => this.readMember(db, ref)); }

  /** Private exact-version source for reconciliation. A snapshot may have more
   * than one admitted version (for example before and after a CDR); a hash alone
   * cannot choose between them. Reject ambiguity instead of selecting the latest.
   * Caller must independently authorize the underlying document and its history. */
  resolve(documentId: string, snapshotSha256: string): Promise<BatchMemberVersion | null> {
    if (!UUID.test(documentId) || !HASH.test(snapshotSha256)) fail();
    return this.locked(async db => {
      const rows = (await db.query(`SELECT version FROM b2b_batch_member_version
        WHERE document_id=$1 AND snapshot_sha256=$2 ORDER BY version LIMIT 2`, [documentId, snapshotSha256])).rows;
      if (rows.length === 0) return null;
      if (rows.length !== 1 || !positive(rows[0].version)) fail('BATCH_MEMBER_CHANGED');
      const member = {documentId, version: rows[0].version, snapshotSha256};
      const record = await this.readMember(db, member);
      if (!record || !equal(record.member, member)) fail('BATCH_MEMBER_CHANGED');
      return json(member);
    });
  }

  private async authorization(db: BatchSqlConnection, subject: BatchSubject, member: BatchOwnerMember,
    permission: 'READ' | 'WRITE', kind: 'RC' | 'RA'): Promise<BatchMemberGrant> {
    actor(subject);
    const receipt = json(await this.identity.current(subject, this.now()));
    fresh(receipt.checkedAt, this.now());
    if (!equal(receipt.subject, subject) || !positive(receipt.clientRevision) ||
      !(subject.kind === 'SERVICE' ? receipt.userAuthRevision === null : Number.isSafeInteger(receipt.userAuthRevision) && Number(receipt.userAuthRevision) >= 0)) fail('BATCH_MEMBER_DENIED');
    const k = grantKey(subject, member.binding, kind, permission);
    const row = (await db.query('SELECT policy,revision FROM b2b_batch_member_grant WHERE grant_key=$1', [k])).rows[0];
    if (!row || !row.policy.active || !equal(row.policy.subject, subject) || !equal(row.policy.binding, member.binding) ||
      row.policy.kind !== kind || row.policy.permission !== permission || row.policy.clientRevision !== receipt.clientRevision ||
      row.policy.userAuthRevision !== receipt.userAuthRevision) fail('BATCH_MEMBER_DENIED');
    return { subject, binding: member.binding, permission, clientRevision: receipt.clientRevision,
      userAuthRevision: receipt.userAuthRevision, grantRevision: row.revision, checkedAt: receipt.checkedAt };
  }
  authorize(subject: BatchSubject, member: BatchOwnerMember, permission: 'READ' | 'WRITE', kind: 'RC' | 'RA') {
    return this.locked(db => this.authorization(db, subject, member, permission, kind));
  }

  private async fence(db: BatchSqlConnection, plan: BatchMemberPlan): Promise<void> {
    for (const mark of plan.members) {
      const record = await this.readMember(db, mark.record.member);
      if (!record || !equal(record, mark.record)) fail('BATCH_MEMBER_CHANGED');
      const { checkedAt: _, ...grant } = await this.authorization(db, plan.subject, record, plan.permission, plan.request.kind);
      if (!equal(grant, mark.grant)) fail('BATCH_AUTHORITY_CHANGED');
    }
    // Complete credit closure comes from the SQL catalogue, not a caller boolean. Historical
    // note edges stay acyclic at admission; union the roots and dependencies for today's fence.
    const covered = new Set(plan.members.map(m => key(m.record.member)));
    for (const entry of plan.request.entries) {
      const root = plan.members.find(m => equal(m.record.member, entry.member))!.record;
      if (root.note) for (const credit of await this.creditCatalogue(db, root.note.original.documentId))
        if (!covered.has(key(credit.member))) fail('BATCH_MEMBER_CHANGED');
      // Reversal/modification of an original with admitted credits has no implemented release
      // protocol. Reject rather than silently declaring a financially complete closure.
      if (!root.note && (await this.creditCatalogue(db, root.member.documentId)).length) fail('BATCH_MEMBER_CHANGED');
    }
  }

  async transaction<T>(plan: BatchMemberPlan, work: (tx: BatchMemberTransaction<BatchLocalProducerTransaction>) => Promise<T>): Promise<T> {
    return this.locked(async db => {
      let open = true, reservation: { identity: { documentId: string; identifier: string; issueDate: string; referenceDate: string };
        eventId: string; correlationId: string } | undefined;
      let persisted: { batchId: string; eventId: string; identifier: string; state: 'PREPARED'; localOnly: true;
        fiscalExecutionEnabled: false; officialAcceptance: false } | undefined;
      let producing: Promise<NonNullable<typeof persisted>> | undefined, poisoned = false;
      const check = () => { if (!open) fail('BATCH_CALLBACK_CLOSED'); };
      const jKey = journalKey(plan.subject, plan.request.scope, plan.request.idempotencyKey);
      // Global lane prevents phantoms. Specific document/grant locks make the local fence explicit.
      const documentIds = [...new Set(plan.members.map(m => m.record.member.documentId))].sort();
      for (const id of documentIds) {
        await db.query('SELECT document_id FROM b2b_batch_member_document WHERE document_id=$1 FOR UPDATE', [id]);
        await db.query('SELECT version FROM b2b_batch_member_version WHERE document_id=$1 ORDER BY version FOR UPDATE', [id]);
      }
      const historyIds = [...new Set(plan.members.map(m => m.record.note?.original.documentId ?? m.record.member.documentId))].sort();
      for (const id of historyIds) await db.query('SELECT revision FROM b2b_batch_member_history WHERE original_id=$1 FOR UPDATE', [id]);
      const grantIds = [...new Set(plan.members.map(m => grantKey(plan.subject, m.record.binding, plan.request.kind, plan.permission)))].sort();
      for (const id of grantIds) await db.query('SELECT grant_key FROM b2b_batch_member_grant WHERE grant_key=$1 FOR UPDATE', [id]);
      const storePrepared = async (prepared: BatchPrepared) => {
        check(); if (prepared.plan !== plan || !reservation || persisted) fail('BATCH_PLAN_REQUIRED');
        await this.fence(db, plan);
        const command = validateFiscalSupplementCommand(prepared.command), envelope = command.payload.envelope;
        if (envelope.kind !== 'BATCH' || envelope.batch.documentId !== reservation.identity.documentId ||
          command.eventId !== reservation.eventId || command.correlationId !== reservation.correlationId ||
          !equal(envelope.batch.input, plan.input) || prepared.ubl !== buildFiscalBatchUbl(envelope.batch, envelope.asOf)) fail();
        await db.query(`INSERT INTO b2b_batch_member_command(batch_id,command_sha256,command,ubl,subject,request,request_sha256)
          VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7)`,
          [envelope.batch.documentId, hash(command), JSON.stringify(command), prepared.ubl, JSON.stringify(plan.subject),
            JSON.stringify(plan.request), plan.requestSha256]);
        persisted = { batchId: envelope.batch.documentId, eventId: command.eventId, identifier: envelope.batch.identifier,
          state: 'PREPARED', localOnly: true, fiscalExecutionEnabled: false, officialAcceptance: false };
        await db.query(`INSERT INTO b2b_batch_member_local_outbox(event_id,batch_id,topic,payload)
          VALUES($1,$2,'factuez.b2b.batch.local.prepared.v1',$3::jsonb)`, [persisted.eventId, persisted.batchId, JSON.stringify(persisted)]);
        return json(persisted);
      };
      const persist = async (prepared: BatchPrepared) => {
        check();
        if (producing) { poisoned = true; fail('BATCH_CALLBACK_REENTRY'); }
        const pending = storePrepared(prepared); producing = pending;
        try { return await pending; }
        catch (error) { poisoned = true; throw error; }
        finally { producing = undefined; }
      };
      const tx: BatchMemberTransaction<BatchLocalProducerTransaction> = {
        owner: Object.freeze({ persist }),
        member: async ref => { check(); return this.readMember(db, ref); },
        authorize: async (...args) => { check(); return this.authorization(db, ...args); },
        fence: async p => { check(); if (p !== plan) fail('BATCH_PLAN_REQUIRED'); await this.fence(db, p); },
        journal: async (subject, scope, idempotencyKey) => {
          check(); if (journalKey(subject, scope, idempotencyKey) !== jKey) fail('BATCH_JOURNAL_CONFLICT');
          const row = (await db.query('SELECT record,record_sha256 FROM b2b_batch_member_journal WHERE journal_key=$1', [jKey])).rows[0];
          if (!row) return null;
          const record = json(row.record) as BatchJournal;
          if (hash(record) !== row.record_sha256) fail('BATCH_JOURNAL_CONFLICT'); return record;
        },
        reserveIdentity: async p => {
          check(); if (p !== plan || reservation) fail('BATCH_PLAN_REQUIRED'); await this.fence(db, plan);
          // Deliberate owner counter, date/kind scoped. Never MAX(observed identifiers).
          const counterKey = hash({ environment: 'BETA', issuerRuc: plan.request.scope.issuerRuc, kind: plan.request.kind, issueDate: plan.request.issueDate });
          const counter = (await db.query(`INSERT INTO b2b_batch_member_counter(counter_key,last_number) VALUES($1,1)
            ON CONFLICT(counter_key) DO UPDATE SET last_number=b2b_batch_member_counter.last_number+1
            RETURNING last_number`, [counterKey])).rows[0];
          const identity = { documentId: randomUUID(), identifier: `${plan.request.kind}-${plan.request.issueDate.replaceAll('-', '')}-${counter.last_number}`,
            issueDate: plan.request.issueDate, referenceDate: plan.request.referenceDate };
          reservation = { identity, eventId: randomUUID(), correlationId: randomUUID() };
          const operation = hash({ scope: plan.request.scope, kind: plan.request.kind, issueDate: plan.request.issueDate,
            referenceDate: plan.request.referenceDate, entries: plan.request.entries });
          await db.query(`INSERT INTO b2b_batch_member_reservation(journal_key,operation_sha256,batch_id,event_id,correlation_id,identifier,counter_key)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [jKey, operation, identity.documentId, reservation.eventId, reservation.correlationId, identity.identifier, counterKey]);
          for (const id of [...plan.request.entries.map(e => e.member.documentId)].sort())
            await db.query('INSERT INTO b2b_batch_member_claim(document_id,journal_key) VALUES($1,$2)', [id, jKey]);
          return reservation;
        },
        appendJournal: async value => {
          check(); const journal = json(value);
          if (!persisted || !reservation || !equal(journal.result, persisted) || journal.command.payload.operationId !== persisted.batchId ||
            journal.command.eventId !== persisted.eventId || journal.requestSha256 !== plan.requestSha256 ||
            journal.membersSha256 !== plan.membersSha256 || journal.commandSha256 !== hash(journal.command) ||
            journalKey(journal.subject, journal.scope, journal.idempotencyKey) !== jKey || journal.state !== 'PREPARED') fail('BATCH_JOURNAL_CONFLICT');
          await db.query(`INSERT INTO b2b_batch_member_journal(journal_key,batch_id,record,record_sha256) VALUES($1,$2,$3::jsonb,$4)`,
            [jKey, persisted.batchId, JSON.stringify(journal), hash(journal)]);
        },
      };
      try {
        const result = await work(tx);
        if (producing) { poisoned = true; await producing; }
        if (poisoned) fail('BATCH_CALLBACK_REENTRY');
        await this.fence(db, plan); return result;
      } finally {
        open = false;
        if (producing) { try { await producing; } catch { /* Rollback is handled by locked(). */ } }
      }
    });
  }
}
