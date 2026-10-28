import { createHash } from 'node:crypto';
import { fiscalSnapshotSha256 as hash, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';
import { type CarrierGuideReferenceOwnerPort, type CarrierReference09Evidence,
  type CarrierReference09OwnerQuery, type CarrierReference09Snapshot } from '@factuez/sunat-core/dist/carrier-guide-profile';
import type { GuideEstablishmentDatabase, GuideEstablishmentSql } from './guide-establishment-store';
import { carrierExact, carrierFail, carrierHash, carrierInteger, carrierJson, carrierUuid } from './carrier-guide-model';
import { projectPublicGuide09OwnerSnapshot, type PublicGuide09OwnerSnapshot } from '@factuez/sunat-core/dist/public-guide-profile';

/** This public09 owner record is a distinct contract. A private02 issued-v1
 * snapshot cannot be ingested or re-labelled through this adapter. */
export type CarrierPublic09OwnerSnapshot = PublicGuide09OwnerSnapshot;
export type CarrierReferenceArtifacts = { signedXml: Uint8Array; cdrXml: Uint8Array };
export type CarrierReferenceValidationInput = {
  ownerSnapshot: CarrierPublic09OwnerSnapshot; ownerSnapshotSha256: string;
  projection: CarrierReference09Snapshot; projectionSha256: string;
  signedXml: Uint8Array; signedXmlSha256: string; cdrXml: Uint8Array; cdrSha256: string;
};
/** Server-only cryptographic capability. Must verify the original signed 09
 * XML and authenticated CDR, document IDs, issuer, full number, full snapshot,
 * transport01, all projection fields and exact supplied artifact bytes. Throw
 * on signature failure/revocation; return the parsed acceptance, never a boolean.
 * No default verifier, HTTP approval flag or network fallback exists. */
export interface CarrierReferenceSignatureCdrValidator {
  verify(input: Readonly<CarrierReferenceValidationInput>): Promise<CarrierReference09Evidence['acceptance']>;
}
export type CarrierReferenceAccess = { companyId: number; branchId: string; issuerRuc: string };
const digest = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
function freezeJson<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freezeJson(child); Object.freeze(v); }
  return v;
}
const options = { isolationLevel: 'Serializable' as const, timeout: 15000, maxWait: 3000 };

export function projectCarrierPublic09Owner(raw: unknown): CarrierReference09Snapshot {
  return projectPublicGuide09OwnerSnapshot(raw);
}
function artifactCopy(v: unknown): Buffer {
  if (!(v instanceof Uint8Array) || v.byteLength < 1 || v.byteLength > 384 * 1024) carrierFail('CARRIER_REFERENCE_ARTIFACT_BOUND');
  return Buffer.from(v as Uint8Array);
}
async function verified(validator: CarrierReferenceSignatureCdrValidator, snapshot: CarrierPublic09OwnerSnapshot, artifacts: CarrierReferenceArtifacts) {
  const ownerSnapshot = freezeJson(carrierJson<CarrierPublic09OwnerSnapshot>(snapshot)), projection = freezeJson(projectCarrierPublic09Owner(ownerSnapshot));
  const signedXml = artifactCopy(artifacts.signedXml), cdrXml = artifactCopy(artifacts.cdrXml);
  const input: CarrierReferenceValidationInput = { ownerSnapshot, ownerSnapshotSha256: hash(ownerSnapshot), projection,
    projectionSha256: hash(projection), signedXml, signedXmlSha256: digest(signedXml), cdrXml, cdrSha256: digest(cdrXml) };
  const before = hash({ ownerSnapshot, projection, signedXmlSha256: input.signedXmlSha256, cdrSha256: input.cdrSha256 });
  Object.freeze(input);
  let acceptance: CarrierReference09Evidence['acceptance'];
  try { acceptance = carrierJson(await validator.verify(input)); }
  catch { return carrierFail('CARRIER_REFERENCE_CRYPTO_UNVERIFIED'); }
  if (before !== hash({ ownerSnapshot, projection, signedXmlSha256: digest(signedXml), cdrSha256: digest(cdrXml) })) carrierFail('CARRIER_REFERENCE_INPUT_CHANGED');
  carrierExact(acceptance, ['environment', 'documentId', 'issuerRuc', 'fullNumber', 'snapshotSha256', 'cdrSha256', 'responseCode', 'status', 'acceptedAt']);
  fiscalTimestamp(acceptance.acceptedAt, 'acceptedAt');
  if (new Date(acceptance.acceptedAt).toISOString() !== acceptance.acceptedAt || acceptance.environment !== 'BETA' || acceptance.documentId !== projection.documentId || acceptance.issuerRuc !== projection.issuer.ruc ||
    acceptance.fullNumber !== `${projection.series}-${projection.number}` || acceptance.snapshotSha256 !== hash(projection) ||
    acceptance.cdrSha256 !== digest(cdrXml) || acceptance.responseCode !== '0' ||
    !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(acceptance.status) || acceptance.acceptedAt < projection.issueDate)
    carrierFail('CARRIER_REFERENCE_ACCEPTANCE_MISMATCH');
  return { input, evidence: { snapshot: projection, acceptance } satisfies CarrierReference09Evidence };
}

/** Concrete transaction-bound owner: reads immutable full owner records AND
 * stored artifact bytes; re-verifies cryptography and current access on every load. */
export class PostgresCarrierReference09Owner implements CarrierGuideReferenceOwnerPort {
  constructor(private readonly sql: GuideEstablishmentSql, private readonly validator: CarrierReferenceSignatureCdrValidator,
    private readonly now: () => string = () => new Date().toISOString()) {}
  async loadAcceptedReference09(raw: Readonly<CarrierReference09OwnerQuery>): Promise<CarrierReference09Evidence> {
    const q = carrierJson<CarrierReference09OwnerQuery>(raw);
    carrierExact(q, ['companyId', 'branchId', 'issuerRuc', 'documentId', 'operationId', 'snapshotSha256', 'asOf', 'reference09']);
    if (!carrierInteger(q.companyId) || !carrierUuid(q.branchId) || !carrierUuid(q.documentId) || !carrierUuid(q.operationId) ||
      !carrierHash(q.snapshotSha256) || !carrierUuid(q.reference09.documentId)) carrierFail('CARRIER_REFERENCE_QUERY_INVALID');
    const rows = await this.sql.$queryRawUnsafe<{ revision: number; ownerSnapshot: CarrierPublic09OwnerSnapshot; ownerSnapshotSha256: string;
      projection: CarrierReference09Snapshot; projectionSha256: string; signedXml: Uint8Array; signedXmlSha256: string; cdrXml: Uint8Array;
      cdrSha256: string; acceptance: CarrierReference09Evidence['acceptance']; accessRevision: number }[]>(`
      SELECT v."revision",v."ownerSnapshot",v."ownerSnapshotSha256",v."projection",v."projectionSha256",
        v."signedXml",v."signedXmlSha256",v."cdrXml",v."cdrSha256",v."acceptance",g."revision" AS "accessRevision" FROM "CarrierReference09Head" h
      JOIN "CarrierReference09Version" v ON v."documentId"=h."documentId" AND v."revision"=h."revision"
      JOIN "CarrierReference09Access" g ON g."referenceId"=h."documentId"
      JOIN "CompanySettings" c ON c."id"=g."companyId"
      JOIN "Branch" b ON b."id"=g."branchId" AND b."companyId"=c."id"
      WHERE h."documentId"=$1::uuid AND h."active"=true AND g."active"=true
        AND g."companyId"=$2 AND g."branchId"=$3::uuid AND g."issuerRuc"=$4
        AND c."ruc"=$4 AND c."environment"='BETA' AND c."active"=true AND b."active"=true
      FOR SHARE OF h,g,c,b`, q.reference09.documentId, q.companyId, q.branchId, q.issuerRuc);
    if (rows.length !== 1) carrierFail('CARRIER_REFERENCE_ACCESS_DENIED', 403);
    const row = rows[0];
    const pins = await this.sql.$queryRawUnsafe<{ operationId: string; companyId: number; issuerRuc: string; branchId: string; snapshotSha256: string;
      referenceId: string; referenceRevision: number; accessRevision: number; ownerSnapshotSha256: string; projectionSha256: string; signedXmlSha256: string; cdrSha256: string }[]>(`
      SELECT h."operationId",h."companyId",h."issuerRuc",h."binding"->'draft'->'anchor'->>'branchId' AS "branchId",h."snapshotSha256",
        p."referenceId",p."referenceRevision",p."accessRevision",p."ownerSnapshotSha256",p."projectionSha256",p."signedXmlSha256",p."cdrSha256"
      FROM "CarrierGuideDocument" h LEFT JOIN "CarrierGuideReferenceBinding" p ON p."documentId"=h."documentId" WHERE h."documentId"=$1::uuid`, q.documentId);
    if (pins.length > 1 || pins.some(p => p.operationId !== q.operationId || p.companyId !== q.companyId || p.issuerRuc !== q.issuerRuc ||
      p.branchId !== q.branchId || p.snapshotSha256 !== q.snapshotSha256 || p.referenceId !== q.reference09.documentId || p.referenceRevision !== row.revision ||
      p.accessRevision !== row.accessRevision || p.ownerSnapshotSha256 !== row.ownerSnapshotSha256 || p.projectionSha256 !== row.projectionSha256 ||
      p.signedXmlSha256 !== row.signedXmlSha256 || p.cdrSha256 !== row.cdrSha256)) carrierFail('CARRIER_REFERENCE_VERSION_REPLACED');
    const result = await verified(this.validator, row.ownerSnapshot, { signedXml: row.signedXml, cdrXml: row.cdrXml });
    if (!carrierInteger(row.revision) || !carrierInteger(row.accessRevision) || row.ownerSnapshotSha256 !== result.input.ownerSnapshotSha256 ||
      row.projectionSha256 !== result.input.projectionSha256 || hash(row.projection) !== result.input.projectionSha256 ||
      row.signedXmlSha256 !== result.input.signedXmlSha256 || row.cdrSha256 !== result.input.cdrSha256 ||
      hash(row.acceptance) !== hash(result.evidence.acceptance) || row.projectionSha256 !== q.reference09.snapshotSha256 ||
      row.projection.documentId !== q.reference09.documentId || row.projection.issuer.ruc !== q.reference09.issuerRuc ||
      row.projection.series !== q.reference09.series || row.projection.number !== q.reference09.number ||
      result.evidence.acceptance.acceptedAt > q.asOf || result.evidence.acceptance.acceptedAt > this.now()) carrierFail('CARRIER_REFERENCE_OWNER_MISMATCH');
    return carrierJson(result.evidence);
  }
}

/** Explicit PRIVATE ingestion capability. Never register this object as an HTTP
 * request handler. Access enrolment originates with the trusted owner bridge. */
export function createCarrierReference09Ingestion(database: GuideEstablishmentDatabase, validator: CarrierReferenceSignatureCdrValidator,
  now: () => string = () => new Date().toISOString()) {
  if (!validator || typeof validator.verify !== 'function') carrierFail('CARRIER_REFERENCE_VALIDATOR_REQUIRED', 503);
  return Object.freeze({ async ingest(ownerInput: CarrierPublic09OwnerSnapshot, artifacts: CarrierReferenceArtifacts, accessInput: CarrierReferenceAccess) {
    const access = carrierJson<CarrierReferenceAccess>(accessInput);
    carrierExact(access, ['companyId', 'branchId', 'issuerRuc']);
    if (!carrierInteger(access.companyId) || !carrierUuid(access.branchId)) carrierFail('CARRIER_REFERENCE_ACCESS_INVALID');
    const result = await verified(validator, ownerInput, artifacts), v = result.input, e = result.evidence;
    if (access.issuerRuc !== e.snapshot.carrier.ruc || e.acceptance.acceptedAt > now()) carrierFail('CARRIER_REFERENCE_ACCESS_INVALID');
    return database.$transaction(async sql => {
      await sql.$queryRawUnsafe('SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))', `carrier-reference:${e.snapshot.documentId}`);
      const target = await sql.$queryRawUnsafe<{ id: number }[]>(`SELECT c."id" FROM "CompanySettings" c JOIN "Branch" b ON b."companyId"=c."id"
        WHERE c."id"=$1 AND c."ruc"=$2 AND c."environment"='BETA' AND c."active"=true AND b."id"=$3::uuid AND b."active"=true FOR SHARE OF c,b`, access.companyId, access.issuerRuc, access.branchId);
      if (target.length !== 1) carrierFail('CARRIER_REFERENCE_ACCESS_INVALID');
      const heads = await sql.$queryRawUnsafe<{ revision: number }[]>('SELECT "revision" FROM "CarrierReference09Head" WHERE "documentId"=$1::uuid FOR UPDATE', e.snapshot.documentId);
      const revision = (heads[0]?.revision ?? 0) + 1;
      await sql.$executeRawUnsafe(`INSERT INTO "CarrierReference09Version"
        ("documentId","revision","ownerSnapshot","ownerSnapshotSha256","projection","projectionSha256","signedXml","signedXmlSha256","cdrXml","cdrSha256","acceptance")
        VALUES ($1::uuid,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)`, e.snapshot.documentId, revision,
        JSON.stringify(v.ownerSnapshot), v.ownerSnapshotSha256, JSON.stringify(v.projection), v.projectionSha256,
        Buffer.from(v.signedXml), v.signedXmlSha256, Buffer.from(v.cdrXml), v.cdrSha256, JSON.stringify(e.acceptance));
      await sql.$executeRawUnsafe(`INSERT INTO "CarrierReference09Head" ("documentId","revision","active") VALUES ($1::uuid,$2,true)
        ON CONFLICT ("documentId") DO UPDATE SET "revision"=$2,"active"=true`, e.snapshot.documentId, revision);
      await sql.$executeRawUnsafe(`INSERT INTO "CarrierReference09Access" ("referenceId","companyId","branchId","issuerRuc","revision","active") VALUES ($1::uuid,$2,$3::uuid,$4,1,true)
        ON CONFLICT ("referenceId","companyId","branchId") DO UPDATE SET "revision"="CarrierReference09Access"."revision"+1,"active"=true,"issuerRuc"=$4`,
      e.snapshot.documentId, access.companyId, access.branchId, access.issuerRuc);
      return { documentId: e.snapshot.documentId, revision, projection: carrierJson<CarrierReference09Snapshot>(e.snapshot), projectionSha256: v.projectionSha256 };
    }, options);
  } });
}
