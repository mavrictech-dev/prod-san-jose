import { Injectable, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { NoteQaSnapshot } from '@factuez/sunat-core/dist/notes-qa';
import { PrismaService } from '../infrastructure/prisma.service';
import { LOCAL_PREPARATION_MAX_ATTEMPTS, localPreparationRetryDelay } from './local-preparation-policy';
import { notesTransport, type NotesTransportQa } from './notes-transport-qa.types';

export const NOTES_QA_LEASE_MS = 60000;

export type NoteQaArtifact = { storageKey: string; sha256: string; sizeBytes: number };
export type NotesQaRow = {
  id: string; originalDocumentId: string; actorId: string; idempotencyKey: string; requestSha256: string;
  originalSha256: string; originalCircuitId: string; credentialRevision: number; certificateFingerprint: string;
  // SIGNING: último heartbeat del lease. QUEUED: notBefore durable; NULL permite claim inmediato.
  snapshot: NoteQaSnapshot; state: string; attempts: number; claimedAt: Date | null; createdAt: Date;
  digestValue: string | null; xmlArtifact: NoteQaArtifact | null; zipArtifact: NoteQaArtifact | null;
  xsdEvidence: unknown | null; description: string | null;
};
export type NotesQaAdmission = Omit<NotesQaRow, 'snapshot' | 'state' | 'attempts' | 'claimedAt' | 'createdAt' | 'digestValue' | 'xmlArtifact' | 'zipArtifact' | 'xsdEvidence' | 'description'>;

/** SQL fijo y valores parametrizados: tablas nuevas, exclusivamente BD de SUNAT. */
@Injectable()
export class NotesQaRepository {
  constructor(private readonly prisma: PrismaService) {}
  async rows(originalDocumentId: string) {
    return this.prisma.$queryRawUnsafe<NotesQaRow[]>('SELECT * FROM "NotesQa" WHERE "originalDocumentId"=$1::uuid ORDER BY "createdAt" DESC LIMIT 50', originalDocumentId);
  }
  async find(id: string) {
    return (await this.prisma.$queryRawUnsafe<NotesQaRow[]>('SELECT * FROM "NotesQa" WHERE "id"=$1::uuid', id))[0] ?? null;
  }
  async admitted(originalDocumentId: string, actorId: string, key: string) {
    return (await this.prisma.$queryRawUnsafe<NotesQaRow[]>('SELECT * FROM "NotesQa" WHERE "originalDocumentId"=$1::uuid AND "actorId"=$2::uuid AND "idempotencyKey"=$3::uuid', originalDocumentId, actorId, key))[0] ?? null;
  }
  async reserve(admission: NotesQaAdmission, original: FiscalDocumentSnapshot, makeSnapshot: (number: string) => NoteQaSnapshot) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', `${original.issuer.identityNumber}:BETA`);
      await tx.$queryRawUnsafe('SELECT "documentId" FROM "FiscalDocument" WHERE "documentId"=$1::uuid FOR UPDATE', original.documentId);
      const credential = await tx.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: original.issuer.identityNumber, environment: 'BETA' } } });
      if (credential?.revision !== admission.credentialRevision || credential.certificateFingerprint !== admission.certificateFingerprint ||
        credential.certificateSelfSigned !== true || !credential.certificateExpiresAt || credential.certificateExpiresAt <= new Date()) throw new ConflictException('El certificado cambió o no está vigente');
      const reference = await tx.fiscalCircuitQa.findUnique({ where: { documentId: original.documentId } });
      if (reference?.id !== admission.originalCircuitId || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(reference.state) || !reference.cdrZipArtifact) throw new ConflictException('La referencia QA cambió');
      const prior = (await tx.$queryRawUnsafe<NotesQaRow[]>('SELECT * FROM "NotesQa" WHERE "originalDocumentId"=$1::uuid AND "actorId"=$2::uuid AND "idempotencyKey"=$3::uuid', original.documentId, admission.actorId, admission.idempotencyKey))[0];
      if (prior) { if (prior.requestSha256 !== admission.requestSha256) throw new ConflictException('Clave de idempotencia reutilizada con otra solicitud'); return prior; }
      const existing = await tx.$queryRawUnsafe<{ count: bigint }[]>('SELECT COUNT(*)::bigint AS count FROM "NotesQa" WHERE "originalDocumentId"=$1::uuid', original.documentId);
      if (existing[0].count >= 20n) throw new ConflictException('Límite de 20 notas QA por referencia');
      const provisional = makeSnapshot('1');
      if (provisional.documentTypeCode === '07') {
        const credit = await tx.$queryRawUnsafe<{ id: string }[]>('SELECT "id" FROM "NotesQa" WHERE "originalDocumentId"=$1::uuid AND "documentTypeCode"=\'07\' LIMIT 1', original.documentId);
        if (credit.length) throw new ConflictException('Perfil v1: un crédito reservado por original. Use otro comprobante ficticio para evitar sobreacreditar');
      }
      const counterKey = `${original.issuer.identityNumber}:${provisional.documentTypeCode}:${provisional.series}`;
      const numbers = await tx.$queryRawUnsafe<{ lastNumber: number }[]>('INSERT INTO "NotesQaCounter"("id","lastNumber") VALUES($1,1) ON CONFLICT("id") DO UPDATE SET "lastNumber"="NotesQaCounter"."lastNumber"+1 RETURNING "lastNumber"', counterKey);
      if (numbers[0].lastNumber > 99999999) throw new ConflictException('Correlativo QA agotado');
      const snapshot = makeSnapshot(String(numbers[0].lastNumber));
      return (await tx.$queryRawUnsafe<NotesQaRow[]>(`INSERT INTO "NotesQa"
        ("id","originalDocumentId","actorId","idempotencyKey","requestSha256","originalSha256","originalCircuitId","credentialRevision","certificateFingerprint","issuerRuc","documentTypeCode","series","number","snapshot")
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`,
        admission.id, original.documentId, admission.actorId, admission.idempotencyKey, admission.requestSha256,
        admission.originalSha256, admission.originalCircuitId, admission.credentialRevision, admission.certificateFingerprint,
        original.issuer.identityNumber, snapshot.documentTypeCode, snapshot.series, Number(snapshot.number), JSON.stringify(snapshot)))[0];
    }, { timeout: 10000 });
  }
  async pending() {
    // Firmar de nuevo es seguro: no existe envío externo ni asignación de otro número.
    const expired = await this.prisma.$queryRawUnsafe<NotesQaRow[]>('SELECT * FROM "NotesQa" WHERE "state"=\'SIGNING\' AND "claimedAt"<=NOW()-($1::double precision*INTERVAL \'1 millisecond\') ORDER BY "claimedAt" LIMIT 20', NOTES_QA_LEASE_MS);
    for (const row of expired) await this.requeue(row, true);
    return this.prisma.$queryRawUnsafe<NotesQaRow[]>('SELECT * FROM "NotesQa" WHERE "state"=\'QUEUED\' AND "attempts"<$1 AND ("claimedAt" IS NULL OR "claimedAt"<=NOW()) ORDER BY "createdAt" LIMIT 20', LOCAL_PREPARATION_MAX_ATTEMPTS);
  }
  async claim(id: string) {
    return (await this.prisma.$queryRawUnsafe<NotesQaRow[]>('UPDATE "NotesQa" SET "state"=\'SIGNING\',"attempts"="attempts"+1,"claimedAt"=NOW() WHERE "id"=$1::uuid AND "state"=\'QUEUED\' AND "attempts"<$2 AND ("claimedAt" IS NULL OR "claimedAt"<=NOW()) RETURNING *', id, LOCAL_PREPARATION_MAX_ATTEMPTS))[0] ?? null;
  }
  async heartbeat(row: NotesQaRow): Promise<boolean> {
    const affected = await this.prisma.$executeRawUnsafe('UPDATE "NotesQa" SET "claimedAt"=NOW() WHERE "id"=$1::uuid AND "state"=\'SIGNING\' AND "attempts"=$2 AND "claimedAt">NOW()-($3::double precision*INTERVAL \'1 millisecond\')', row.id, row.attempts, NOTES_QA_LEASE_MS);
    return affected === 1;
  }
  private async requeue(row: NotesQaRow, expired: boolean): Promise<boolean> {
    // CAS por estado, intento y vigencia: ni un worker viejo ni un reclaim tardío
    // pueden tocar el lease renovado. No modifica snapshot, reserva ni correlativo.
    const lease = expired ? '<=' : '>';
    const affected = await this.prisma.$executeRawUnsafe(`UPDATE "NotesQa" SET
      "state"=CASE WHEN "attempts"<$3 THEN 'QUEUED' ELSE 'BLOCKED' END,
      "claimedAt"=CASE WHEN "attempts"<$3 THEN NOW()+($4::double precision*INTERVAL '1 millisecond') ELSE NULL END,
      "description"=CASE WHEN "attempts"<$3 THEN $5 ELSE 'Preparación local agotó sus intentos; reserva QA conservada, sin envío' END
      WHERE "id"=$1::uuid AND "state"='SIGNING' AND "attempts"=$2
      AND "claimedAt"${lease}NOW()-($6::double precision*INTERVAL '1 millisecond')`,
      row.id, row.attempts, LOCAL_PREPARATION_MAX_ATTEMPTS, localPreparationRetryDelay(row.attempts),
      expired ? 'Lease de firma vencido; reintento local diferido, sin envío' : 'Preparación local no disponible; reintento diferido, sin envío', NOTES_QA_LEASE_MS);
    return affected === 1;
  }
  async defer(row: NotesQaRow): Promise<boolean> {
    return this.requeue(row, false);
  }
  async complete(row: NotesQaRow, proof: { digestValue: string; xml: NoteQaArtifact; zip: NoteQaArtifact; xsdEvidence: unknown | null }): Promise<boolean> {
    const affected = await this.prisma.$executeRawUnsafe('UPDATE "NotesQa" SET "state"=\'SIGNED_LOCAL\',"digestValue"=$3,"xmlArtifact"=$4::jsonb,"zipArtifact"=$5::jsonb,"xsdEvidence"=$6::jsonb,"description"=\'Nota firmada localmente; sin CDR ni envío SUNAT\',"claimedAt"=NULL WHERE "id"=$1::uuid AND "state"=\'SIGNING\' AND "attempts"=$2 AND "claimedAt">NOW()-($7::double precision*INTERVAL \'1 millisecond\')', row.id, row.attempts, proof.digestValue, JSON.stringify(proof.xml), JSON.stringify(proof.zip), JSON.stringify(proof.xsdEvidence), NOTES_QA_LEASE_MS);
    return affected === 1;
  }
  async block(row: NotesQaRow): Promise<boolean> {
    const affected = await this.prisma.$executeRawUnsafe('UPDATE "NotesQa" SET "state"=\'BLOCKED\',"description"=\'Contexto, firma o integridad fuera del perfil QA; no enviado\',"claimedAt"=NULL WHERE "id"=$1::uuid AND "state"=\'SIGNING\' AND "attempts"=$2 AND "claimedAt">NOW()-($3::double precision*INTERVAL \'1 millisecond\')', row.id, row.attempts, NOTES_QA_LEASE_MS);
    return affected === 1;
  }
  /** Todo el JSON anterior es el token CAS: incluye revisión/fence/lease.
   * SQL fijo; nunca interpolar datos, estados o nombres de campos. */
  async transportCas(row: NotesQaRow, next: NotesTransportQa, guard: 'NONE' | 'READY' | 'OWNED' | 'EXPIRED' = 'NONE', original?: FiscalDocumentSnapshot): Promise<boolean> {
    const affected = await this.prisma.$executeRawUnsafe(`UPDATE "NotesQa" AS n
      SET "xsdEvidence"=jsonb_set(n."xsdEvidence",'{transportQa}',$3::jsonb,true)
      WHERE n."id"=$1::uuid AND n."state"='SIGNED_LOCAL' AND n."xsdEvidence"=$2::jsonb
      AND n."snapshot"=$4::jsonb AND n."credentialRevision"=$5 AND n."certificateFingerprint"=$6
      AND n."xmlArtifact"=$10::jsonb AND n."zipArtifact"=$11::jsonb AND n."digestValue"=$12
      AND ($7='NONE' OR ($7='OWNED' AND n."xsdEvidence"#>>'{transportQa,fence}' IS NOT NULL
        AND (n."xsdEvidence"#>>'{transportQa,leaseUntil}')::numeric>EXTRACT(EPOCH FROM NOW())*1000)
        OR ($7='READY' AND n."xsdEvidence"#>>'{transportQa,state}' IN ('QUEUED','WAITING_TICKET')
        AND (n."xsdEvidence"#>>'{transportQa,notBefore}')::numeric<=EXTRACT(EPOCH FROM NOW())*1000
        AND (n."xsdEvidence"#>>'{transportQa,leaseUntil}')::numeric<=EXTRACT(EPOCH FROM NOW())*1000)
        OR ($7='EXPIRED' AND (n."xsdEvidence"#>>'{transportQa,leaseUntil}')::numeric<=EXTRACT(EPOCH FROM NOW())*1000))
      AND ($9::jsonb IS NULL OR (EXISTS (SELECT 1 FROM "FiscalDocument" f WHERE f."documentId"=$8::uuid
        AND f."immutablePayload"=$9::jsonb AND f."environment"='BETA' AND f."status" IN ('QUEUED','BUILDING')
        AND f."issuerRuc"=n."issuerRuc") AND EXISTS (SELECT 1 FROM "SunatCredentials" c
        WHERE c."issuerRuc"=n."issuerRuc" AND c."environment"='BETA' AND c."revision"=$5
        AND c."certificateFingerprint"=$6 AND c."certificateSelfSigned"=true AND c."certificateExpiresAt">NOW())
        AND EXISTS (SELECT 1 FROM "FiscalCircuitQa" q WHERE q."id"=n."originalCircuitId"
        AND q."documentId"=$8::uuid AND q."state" IN ('ACCEPTED','ACCEPTED_WITH_OBSERVATIONS') AND q."cdrZipArtifact" IS NOT NULL)))`,
      row.id, JSON.stringify(row.xsdEvidence), JSON.stringify(next), JSON.stringify(row.snapshot), row.credentialRevision,
      row.certificateFingerprint, guard, row.originalDocumentId, original ? JSON.stringify(original) : null,
      JSON.stringify(row.xmlArtifact), JSON.stringify(row.zipArtifact), row.digestValue);
    return affected === 1;
  }
  async admitTransport(row: NotesQaRow, original: FiscalDocumentSnapshot, proposal: NotesTransportQa, day: string) {
    return this.prisma.$transaction(async tx => {
      // Comparte lock y secuencia RC existentes con circuitos/lotes; se reserva UNA
      // vez. No modifica NotesQaCounter, key, snapshot ni intentos de firma.
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', `${row.snapshot.issuer.identityNumber}:BETA`);
      const fresh = (await tx.$queryRawUnsafe<NotesQaRow[]>('SELECT * FROM "NotesQa" WHERE "id"=$1::uuid FOR UPDATE', row.id))[0];
      if (!fresh || fresh.state !== 'SIGNED_LOCAL') throw new ConflictException('Nota aún no firmada');
      const previous = notesTransport(fresh.xsdEvidence);
      if (previous) {
        if (previous.scenario !== proposal.scenario) throw new ConflictException('La nota ya reservó otro escenario; no se permite reenviar');
        return fresh;
      }
      if (proposal.mode === 'sendSummary') {
        const numbers = await tx.$queryRawUnsafe<{ lastNumber: number }[]>('INSERT INTO "FiscalQaCounter"("id","lastNumber") VALUES($1,1) ON CONFLICT("id") DO UPDATE SET "lastNumber"="FiscalQaCounter"."lastNumber"+1 RETURNING "lastNumber"', `${row.snapshot.issuer.identityNumber}:${day}`);
        if (numbers[0].lastNumber > 99999) throw new ConflictException('Correlativo RC QA agotado');
        proposal = { ...proposal, reference: `RC-${day}-${numbers[0].lastNumber}`, requestFileName: `${row.snapshot.issuer.identityNumber}-RC-${day}-${numbers[0].lastNumber}.zip` };
      }
      // CAS contra el contexto que el servicio verificó, nunca contra fresh si cambió.
      const repository = new NotesQaRepository(tx as unknown as PrismaService);
      if (!await repository.transportCas(row, proposal, 'NONE', original)) throw new ConflictException('La nota o su contexto cambiaron durante la admisión');
      return { ...fresh, xsdEvidence: { ...(fresh.xsdEvidence as object), transportQa: proposal } } as NotesQaRow;
    }, { timeout: 10000 });
  }
  async transportPending() {
    return this.prisma.$queryRawUnsafe<NotesQaRow[]>(`SELECT * FROM "NotesQa" WHERE "state"='SIGNED_LOCAL'
      AND "xsdEvidence"#>>'{transportQa,profile}'=$1
      AND (("xsdEvidence"#>>'{transportQa,state}' IN ('QUEUED','WAITING_TICKET')
        AND ("xsdEvidence"#>>'{transportQa,notBefore}')::numeric<=EXTRACT(EPOCH FROM NOW())*1000)
        OR ("xsdEvidence"#>>'{transportQa,state}'='SENDING'
        AND ("xsdEvidence"#>>'{transportQa,leaseUntil}')::numeric<=EXTRACT(EPOCH FROM NOW())*1000))
      ORDER BY "createdAt" LIMIT 20`, 'LOCAL-QA-NOTES-TRANSPORT-v1');
  }
  async checkInstalled() {
    try { const result = await this.prisma.$queryRawUnsafe<{ name: string | null }[]>('SELECT to_regclass(\'"NotesQa"\')::text AS name'); if (!result[0]?.name) throw new Error(); }
    catch { throw new ServiceUnavailableException('Instale la expansión aditiva NotesQa antes de habilitar notas locales'); }
  }
}
