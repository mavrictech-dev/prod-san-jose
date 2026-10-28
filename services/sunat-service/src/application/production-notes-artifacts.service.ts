import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
  OnModuleDestroy, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { isDeepStrictEqual } from 'node:util';
import { PRODUCTION_NOTES_ISSUED, PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE, type ProductionNotesAnySnapshot, type FiscalDocumentSnapshot } from '@factuez/contracts';
import { buildInvoiceUbl, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PdfPreviewCache, PDF_RENDERER_VERSION, type PrintFormat, type ProductionNotePdfEvidence } from '@factuez/pdf-renderer';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore, MAX_ARTIFACT_BYTES } from '../infrastructure/artifact-store';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { certificateRucCandidates } from '../infrastructure/crypto/certificate-identity';
import { parseSafeInvoice, verifyLocalSignedInvoice, type XmlRootKind } from '../infrastructure/crypto/xml-signer.service';
import { CAC_NS, CBC_NS, child, children, leaf } from '../infrastructure/sunat/safe-xml';
import { ProductionNotesDispatchRepository, type ProductionNotesFile } from './production-notes-dispatch.repository';
import { ProductionNotesEvidenceService } from './production-notes-evidence.service';
import { productionNotesOriginal03Raw } from './production-notes-rc-original';
import { productionNotesUnsigned, assertProductionNotesContext, productionNotesUsesRc, productionNotesRcSnapshot, buildProductionNotesRc } from './production-notes-rc';
import { CurrentPdfService, type PrintOwner } from './current-pdf.service';

export const PRODUCTION_NOTES_PDF_RENDERER = 'PRODUCTION_NOTES_PDF_RENDERER';
export type ProductionNotesPdfRenderer = (snapshot: ProductionNotesAnySnapshot, format: PrintFormat, proof: ProductionNotePdfEvidence) => Promise<Buffer>;
export type ProductionNotesArtifactKind = 'signed-xml' | 'submission-zip' | 'cdr-xml' | 'cdr-zip';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const finals = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'];
type Original = { documentId: string; kind: string; mediaType: string; storageKey: string; sizeBytes: number | bigint; sha256: string };
const renderNote: ProductionNotesPdfRenderer = async (snapshot, format, proof) =>
  (await import('@factuez/pdf-renderer')).renderProductionNotePdf(snapshot, format, proof);

/** Read-only sidecar for the dedicated production-notes store. No credentials, P12, signing,
 * policy grants, workers, emission or SUNAT transport. Billing current bearer authorizes each
 * read before owner/archive access; original acceptance + all originals/PKI precede PDF cache.
 * PDF accreditation stays fail-closed: EvidenceService evaluates public chains/CRL NOW.
 * RAW preserves original bytes using owner/snapshot/manifest, hash, signature mathematics and
 * ZIP/CDR binding only. RAW never asserts current or historical PKI/CRL validity. */
@Injectable()
export class ProductionNotesArtifactsService implements OnModuleDestroy {
  private readonly cache = new PdfPreviewCache();
  constructor(private readonly prisma: PrismaService, private readonly repository: ProductionNotesDispatchRepository,
    private readonly store: ArtifactStore, private readonly evidence: ProductionNotesEvidenceService,
    private readonly presentation: CurrentPdfService,
    @Optional() @Inject(PRODUCTION_NOTES_PDF_RENDERER) private readonly render: ProductionNotesPdfRenderer = renderNote) {}

  private input(id: string, authorization?: string) {
    if (!UUID.test(id ?? '')) throw new BadRequestException('Documento de nota inválido');
    if (!authorization || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization)) throw new UnauthorizedException('Se requiere un access token Bearer actual');
  }
  private async billing(id: string, authorization: string) {
    let response: Response;
    try {
      response = await fetch(`${process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002'}/api/v1/documents/${id}`, {
        headers: { Authorization: authorization, Accept: 'application/json', 'Cache-Control': 'no-store' },
        redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch { throw new ServiceUnavailableException('No se pudo verificar el acceso actual a la nota/original'); }
    if (response.status === 401) throw new UnauthorizedException('Inicie sesión nuevamente');
    if (response.status === 403) throw new ForbiddenException('Documento fuera de su alcance');
    if (response.status === 404) throw new NotFoundException('Documento no disponible en su alcance');
    if (!response.ok) throw new ServiceUnavailableException('Billing no pudo autorizar la lectura');
    let value: { id: string; immutableSnapshot: ProductionNotesAnySnapshot; companyId?: number; printContext?: PrintOwner };
    try { value = await response.json() as typeof value; }
    catch { throw new ServiceUnavailableException('Respuesta Billing inválida'); }
    if (!value || value.id !== id || value.immutableSnapshot?.documentId !== id) throw new ConflictException('Snapshot autorizado inconsistente');
    return value;
  }
  private async original(id: string, artifact: Original | undefined, mediaType: string, manifest?: ProductionNotesFile) {
    if (!artifact || artifact.documentId !== id || artifact.mediaType !== mediaType || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        BigInt(artifact.sizeBytes) < 1n || BigInt(artifact.sizeBytes) > BigInt(MAX_ARTIFACT_BYTES) ||
        manifest && (manifest.storageKey !== artifact.storageKey || manifest.sha256 !== artifact.sha256 ||
          !Number.isSafeInteger(manifest.sizeBytes) || BigInt(manifest.sizeBytes) !== BigInt(artifact.sizeBytes))) throw new Error('NOTE_ARTIFACT_METADATA_INVALID');
    const bytes = await this.store.read(id, artifact);
    if (!Buffer.isBuffer(bytes) || BigInt(bytes.length) !== BigInt(artifact.sizeBytes) || hash(bytes) !== artifact.sha256) throw new Error('NOTE_ARTIFACT_HASH_INVALID');
    return bytes;
  }

  /** Raw integrity: the note fingerprint is frozen in its manifest, and the invoice bytes are
   * bound to the note's originalAcceptance hashes. Embedded certificates are NOT trust anchors. */
  private rawSigned(ruc: string, bytes: Buffer, unsigned: string, kind: XmlRootKind, fingerprint?: string) {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed = parseSafeInvoice(xml, kind);
    const certificates = parsed.document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
    if (certificates.length !== 1) throw new Error('RAW_SIGNER_REQUIRED');
    const cert = new X509Certificate(Buffer.from((certificates[0].textContent ?? '').replace(/\s/g, ''), 'base64'));
    const actualFingerprint = cert.fingerprint256.replaceAll(':', '').toLowerCase();
    const issuer = certificateRucCandidates(forge.pki.certificateFromPem(cert.toString()).subject.attributes);
    if (cert.ca || issuer.length !== 1 || issuer[0] !== ruc || fingerprint && fingerprint !== actualFingerprint)
      throw new Error('RAW_SIGNER_IDENTITY_MISMATCH');
    return { fingerprint: actualFingerprint, digest: verifyLocalSignedInvoice(xml, cert.toString(), unsigned, kind) };
  }
  /** Historical ZIP/CRC/CDR document binding only. No present PKI or acceptance accreditation. */
  private rawCdr(zip: Buffer, xml: Buffer, ruc: string, type: '01' | '07' | '08' | 'RC', reference: string) {
    const name = `R-${ruc}-${type === 'RC' ? '' : type+'-'}${reference}.xml`, packed = productionTransportXml(zip, name, true);
    const parsed = parseCdrZip(zip, { fileName: name, issuerRuc: ruc, reference });
    if (!packed.xml.equals(xml) || !parsed.xml.equals(xml)) throw new Error('RAW_CDR_ZIP_MISMATCH');
    const text=new TextDecoder('utf-8', {fatal:true}).decode(xml),document=parseSafeInvoice(text,'ApplicationResponse'),root=document.root;
    if(type==='RC'){
      const ds='http://www.w3.org/2000/09/xmldsig#',certificates=document.document.getElementsByTagNameNS(ds,'X509Certificate'),signatures=document.document.getElementsByTagNameNS(ds,'Signature');
      if(certificates.length!==1||signatures.length!==1||signatures[0]!.parentNode!==document.extension)throw Error('RAW_RC_CDR_SIGNATURE_REQUIRED');
      const certificate=new X509Certificate(Buffer.from((certificates[0]!.textContent??'').replace(/\s/g,''),'base64'));
      document.extension.removeChild(signatures[0]!);
      verifyLocalSignedInvoice(text,certificate.toString(),root.toString(),'ApplicationResponse');
    }
    const response = child(root, CAC_NS, 'DocumentResponse'), ref = child(response, CAC_NS, 'DocumentReference');
    const types = children(ref, CBC_NS, 'DocumentTypeCode'), ids = children(child(response, CAC_NS, 'Response'), CBC_NS, 'ReferenceID');
    if (types.length > 1 || types.length === 1 && leaf(ref, CBC_NS, 'DocumentTypeCode', 2) !== type ||
        ids.length > 1 || ids.length === 1 && leaf(child(response, CAC_NS, 'Response'), CBC_NS, 'ReferenceID', 40) !== reference)
      throw new Error('RAW_CDR_DOCUMENT_MISMATCH');
    return parsed;
  }
  private async originalRaw(snapshot: FiscalDocumentSnapshot) {
    if(snapshot.documentTypeCode==='03')return productionNotesOriginal03Raw(snapshot,this.prisma,this.original.bind(this),this.rawSigned.bind(this),this.rawCdr.bind(this));
    const doc = await this.prisma.fiscalDocument.findUnique({ where: { documentId: snapshot.documentId }, include: { artifacts: true, submissions: true } });
    if (!doc || doc.documentId !== snapshot.documentId || doc.environment !== 'PRODUCTION' || doc.documentType !== '01' ||
        doc.issuerRuc !== snapshot.issuer.identityNumber || doc.series !== snapshot.series || doc.number !== BigInt(snapshot.number) ||
        !same(doc.immutablePayload, JSON.parse(JSON.stringify(snapshot))) || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(doc.status) || !doc.acceptedAt)
      throw new Error('RAW_ORIGINAL_OWNER_MISMATCH');
    const one = (kind: string) => {
      const values = doc.artifacts.filter(a => a.kind === kind); if (values.length !== 1) throw new Error('RAW_ORIGINAL_REQUIRED'); return values[0]!;
    };
    const signed = one('SIGNED_XML'), request = one('SUBMISSION_ZIP'), cdrXml = one('CDR_XML'), cdrZip = one('CDR_ZIP');
    const submissions = doc.submissions.filter(a => a.idempotencyKey === `production:${snapshot.documentId}:v1`);
    if (submissions.length !== 1 || submissions[0]!.documentId !== snapshot.documentId || submissions[0]!.channel !== 'SOAP_SEND_BILL' ||
        submissions[0]!.batchId !== null || submissions[0]!.errorCode !== 'DONE' || submissions[0]!.result !== 'SUCCESS' || !submissions[0]!.completedAt ||
        submissions[0]!.requestArtifactKey !== request.storageKey || submissions[0]!.responseArtifactKey !== cdrZip.storageKey)
      throw new Error('RAW_ORIGINAL_SUBMISSION_MISMATCH');
    const xml = await this.original(snapshot.documentId, signed, 'application/xml'), zip = await this.original(snapshot.documentId, request, 'application/zip');
    if (!productionTransportXml(zip, `${snapshot.issuer.identityNumber}-01-${snapshot.fullNumber}.xml`).xml.equals(xml)) throw new Error('RAW_ORIGINAL_ZIP_MISMATCH');
    if (this.rawSigned(snapshot.issuer.identityNumber, xml, buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }), 'Invoice').digest !== doc.digestValue)
      throw new Error('RAW_ORIGINAL_DIGEST_MISMATCH');
    const result = this.rawCdr(await this.original(snapshot.documentId, cdrZip, 'application/zip'),
      await this.original(snapshot.documentId, cdrXml, 'application/xml'), snapshot.issuer.identityNumber, '01', snapshot.fullNumber);
    if (result.status !== doc.status) throw new Error('RAW_ORIGINAL_CDR_STATE_MISMATCH');
    return { profile:'PRODUCTION-01-ARCHIVE-v1' as const, documentId: doc.documentId, snapshotSha256: fiscalSnapshotSha256(snapshot), signedXmlSha256: signed.sha256,
      cdrXmlSha256: cdrXml.sha256, cdrZipSha256: cdrZip.sha256, acceptedAt: doc.acceptedAt.toISOString() };
  }

  private async verified(id: string, authorization: string, mode: 'RAW' | 'PDF') {
    const permitted = await this.billing(id, authorization), note = structuredClone(permitted.immutableSnapshot);
    if (note.environment !== 'PRODUCTION' || !['07', '08'].includes(note.documentTypeCode) || ![PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE].includes(note.profile))
      throw new ConflictException('Entrega limitada a notas productivas de perfiles autorizados');
    const row = await this.repository.load(id);
    if (!row?.payload?.payload?.original) throw new ConflictException('Nota sin dispatch propietario; requiere conciliación');
    const p = structuredClone(row.payload.payload);
    if (!same(p.snapshot, note)) throw new ConflictException('Nota autorizada diferente del snapshot de envío');
    // Revalidate the original's live Billing scope too, never trust an originalId from HTTP alone.
    const ownOriginal = await this.billing(p.original.documentId, authorization);
    if (!same(ownOriginal.immutableSnapshot, p.original)) throw new ConflictException('Original autorizado diferente del snapshot congelado');
    try {
      assertProductionNotesContext(note,p);
      const sha = fiscalSnapshotSha256(note), admission = p.admission;
      // This is a frozen Billing owner revision, not an admission grant or a current-key requirement.
      // Legacy persisted events may omit it. Validate and bind it whenever present.
      const ownerRevisionSha256 = p.ownerRevisionSha256;
      if (ownerRevisionSha256 !== undefined && (typeof ownerRevisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ownerRevisionSha256)))
        throw new Error('NOTE_OWNER_REVISION_INVALID');
      if (row.documentId !== id || row.snapshotSha256 !== sha || row.eventId !== row.payload.eventId ||
          row.payload.eventName !== PRODUCTION_NOTES_ISSUED || row.payload.producer !== 'billing-service' ||
          !UUID.test(row.eventId) || admission?.profile !== note.profile || admission.snapshotSha256 !== sha ||
          admission.authorized !== true || !row.manifest) throw new Error('NOTE_OWNER_CONTEXT_MISMATCH');
      const manifest = structuredClone(row.manifest), rc=manifest.rc, prefix = `${note.issuer.identityNumber}-${note.documentTypeCode}-${note.fullNumber}`;
      if (productionNotesUsesRc(note)!==Boolean(rc) || manifest.fileName !== (rc?note.issuer.identityNumber+'-'+rc.identifier:prefix) + '.zip' || manifest.fingerprint !== admission.certificateFingerprint ||
          manifest.revision !== admission.credentialRevision || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
          !/^[a-f0-9]{64}$/.test(manifest.fingerprint) || !/^[A-Za-z0-9+/]{43}=$/.test(manifest.digest)) throw new Error('NOTE_PREPARED_MANIFEST_MISMATCH');
      const doc = await this.prisma.fiscalDocument.findUnique({ where: { documentId: id }, include: { artifacts: true, submissions: true } });
      if (!doc || doc.documentId !== id || doc.environment !== 'PRODUCTION' || doc.documentType !== note.documentTypeCode ||
          doc.issuerRuc !== note.issuer.identityNumber || doc.series !== note.series || doc.number !== BigInt(note.number) ||
          doc.billingEventId !== row.eventId || doc.digestValue !== manifest.digest ||
          !same(doc.immutablePayload, JSON.parse(JSON.stringify(note)))) throw new Error('NOTE_FISCAL_DOCUMENT_MISMATCH');
      const submissions = doc.submissions;
      if (submissions.length !== 1) throw new Error('NOTE_SINGLE_SUBMISSION_REQUIRED');
      const submission = submissions[0]!;
      if (submission.documentId !== id || (rc ? !submission.batchId : submission.batchId !== null) || submission.channel !== (rc ? 'SOAP_SEND_SUMMARY' : 'SOAP_SEND_BILL') ||
          submission.idempotencyKey !== `production-notes:${id}:v1` || submission.requestArtifactKey !== manifest.zip.storageKey)
        throw new Error('NOTE_SUBMISSION_MISMATCH');
      const frozen = note.originalAcceptance;
      const fresh = mode === 'PDF' ? await this.evidence.original(p.original) : await this.originalRaw(p.original);
      if (!same('receiptSummary' in fresh ? fresh.receiptSummary : undefined, 'receiptSummary' in frozen ? frozen.receiptSummary : undefined))throw Error('NOTE_ORIGINAL_RC_CHANGED');
      if ('profile' in fresh && fresh.profile !== frozen.profile) throw new Error('NOTE_ORIGINAL_ACCEPTANCE_PROFILE_MISMATCH');
      for (const key of ['documentId', 'snapshotSha256', 'signedXmlSha256', 'cdrXmlSha256', 'cdrZipSha256', 'acceptedAt'] as const)
        if (fresh[key] !== frozen[key]) throw new Error('NOTE_ACCEPTED_ORIGINAL_CHANGED');
      const one = (kind: string, required = true) => {
        const matches = doc.artifacts.filter(a => a.kind === kind);
        if (matches.length > 1 || required && matches.length !== 1) throw new Error('NOTE_ORIGINAL_REQUIRED');
        return matches[0];
      };
      const xml = await this.original(id, one('SIGNED_XML'), 'application/xml', manifest.xml);
      const zip = await this.original(id, one('SUBMISSION_ZIP'), 'application/zip', manifest.zip);
      const individualZip=rc?await this.store.read(id,rc.individualZip):zip;
      if (!productionTransportXml(individualZip, prefix + '.xml').xml.equals(xml)) throw new Error('NOTE_EXACT_ZIP_REQUIRED');
      const kind = note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
      const unsigned = productionNotesUnsigned(note,p);
      const signed = mode === 'PDF' ? await this.evidence.signed(note.issuer.identityNumber, xml, unsigned, kind) :
        this.rawSigned(note.issuer.identityNumber, xml, unsigned, kind, manifest.fingerprint);
      if (signed.digest !== manifest.digest || signed.fingerprint !== manifest.fingerprint) throw new Error('NOTE_XML_SIGNER_MISMATCH');
      let receiptSummary:ProductionNotePdfEvidence['receiptSummary'];
      if(rc){
        if(row.rcIdentifier!==rc.identifier)throw Error('NOTE_RC_RESERVATION_MISMATCH');
        const summaryXml=await this.store.read(id,rc.xml);
        if(!productionTransportXml(zip,manifest.fileName.replace(/\.zip$/,'.xml')).xml.equals(summaryXml))throw Error('NOTE_RC_ZIP_MISMATCH');
        const unsignedSummary=buildProductionNotesRc(note,rc.identifier,p);
        const signedSummary=mode==='PDF'?await this.evidence.signed(note.issuer.identityNumber,summaryXml,unsignedSummary,'SummaryDocuments'):this.rawSigned(note.issuer.identityNumber,summaryXml,unsignedSummary,'SummaryDocuments',manifest.fingerprint);
        if(signedSummary.digest!==rc.digest||signedSummary.fingerprint!==manifest.fingerprint)throw Error('NOTE_RC_SIGNATURE_MISMATCH');
        receiptSummary={identifier:rc.identifier,summaryXmlSha256:hash(summaryXml),summaryZipSha256:hash(zip),individualXmlSha256:hash(xml),individualZipSha256:hash(individualZip)};
        const batch=await this.prisma.fiscalBatch.findUnique({where:{summaryId:id}});
        if(!batch||batch.id!==submission.batchId||batch.environment!=='PRODUCTION'||batch.issuerRuc!==note.issuer.identityNumber||batch.identifier!==rc.identifier||batch.billingEventId!==row.eventId||!same(batch.immutablePayload,JSON.parse(JSON.stringify(productionNotesRcSnapshot(note,rc.identifier)))))throw Error('NOTE_RC_BATCH_MISMATCH');
        if(row.phase==='POLLING'||row.phase==='DONE'){
          const tickets=await this.prisma.$queryRawUnsafe<{ticket:string;requestSha256:string}[]>('SELECT "ticket","requestSha256" FROM "ProductionNotesRcTicket" WHERE "documentId"=$1::uuid',id);
          if(tickets.length!==1||tickets[0]!.ticket!==submission.ticket||tickets[0]!.requestSha256!==manifest.zip.sha256)throw Error('NOTE_RC_TICKET_MISMATCH');
        }
      }
      let cdrXml: Buffer | undefined, cdrZip: Buffer | undefined;
      let proof: ProductionNotePdfEvidence = { environment: 'PRODUCTION', status: 'PENDING', digestValue: signed.digest, qrPayload: '', ...(receiptSummary?{receiptSummary}:{}) };
      if (finals.includes(doc.status)) {
        if (doc.status !== 'REJECTED' && (!doc.acceptedAt || !Number.isFinite(doc.acceptedAt.getTime()) || doc.acceptedAt.getTime() < Date.parse(note.issueDate)))
          throw new Error('NOTE_ACCEPTED_AT_MISSING');
        if (row.phase !== 'DONE' || submission.errorCode !== 'DONE' || !submission.completedAt ||
            submission.result !== (doc.status === 'REJECTED' ? 'BUSINESS_ERROR' : 'SUCCESS')) throw new Error('NOTE_FINAL_STATE_MISMATCH');
        const cdrXmlArtifact = one('CDR_XML')!, cdrZipArtifact = one('CDR_ZIP')!;
        if (submission.responseArtifactKey !== cdrZipArtifact.storageKey) throw new Error('NOTE_CDR_SUBMISSION_MISMATCH');
        cdrXml = await this.original(id, cdrXmlArtifact, 'application/xml'); cdrZip = await this.original(id, cdrZipArtifact, 'application/zip');
        const parsed = mode === 'PDF' ? await this.evidence.cdr(cdrZip, cdrXml, note.issuer.identityNumber, rc?'RC':note.documentTypeCode, rc?.identifier??note.fullNumber) :
          this.rawCdr(cdrZip, cdrXml, note.issuer.identityNumber, rc?'RC':note.documentTypeCode, rc?.identifier??note.fullNumber);
        if (parsed.status !== doc.status) throw new Error('NOTE_CDR_FINAL_STATUS_MISMATCH');
        proof = { ...proof, status: parsed.status, responseCode: parsed.code, cdrDescription: parsed.description, cdrNotes: parsed.notes, ...(receiptSummary?{receiptSummary:{...receiptSummary,cdrXmlSha256:hash(cdrXml),cdrZipSha256:hash(cdrZip)}}:{}) };
      } else {
        const phases: Record<string, string[]> = { PREPARING: ['QUEUED', 'SIGNED'], PREPARED: ['SIGNED'], SENDING: ['SUBMITTED'], POLLING:['SUBMITTED'],
          UNKNOWN: ['RETRYABLE_ERROR'], BLOCKED: ['PERMANENT_ERROR'] };
        const pendingOutcome = row.phase === 'UNKNOWN' ? submission.result === 'UNKNOWN' && submission.errorCode === 'UNKNOWN' :
          row.phase === 'BLOCKED' ? submission.result === 'BUSINESS_ERROR' && submission.errorCode === 'BLOCKED' :
          ['SENDING','POLLING'].includes(row.phase) ? submission.result === 'PENDING' && submission.errorCode === row.phase && submission.completedAt == null :
          submission.result === 'PENDING' && ['PREPARED', 'PREPARING'].includes(submission.errorCode ?? '');
        if (!phases[row.phase]?.includes(doc.status) || !pendingOutcome || doc.acceptedAt || submission.errorCode === 'DONE' ||
            one('CDR_XML', false) || one('CDR_ZIP', false) || submission.responseArtifactKey) throw new Error('NOTE_PENDING_RECONCILIATION_REQUIRED');
      }
      const parsed = parseSafeInvoice(new TextDecoder('utf-8', { fatal: true }).decode(xml), kind), root = parsed.root;
      const supplier = child(child(child(root, CAC_NS, 'AccountingSupplierParty'), CAC_NS, 'Party'), CAC_NS, 'PartyIdentification');
      const customer = child(child(child(root, CAC_NS, 'AccountingCustomerParty'), CAC_NS, 'Party'), CAC_NS, 'PartyIdentification');
      const number = leaf(root, CBC_NS, 'ID', 40).split('-');
      proof.qrPayload = [leaf(supplier, CBC_NS, 'ID', 11), note.documentTypeCode, number[0], number[1],
        leaf(child(root, CAC_NS, 'TaxTotal'), CBC_NS, 'TaxAmount', 24),
        leaf(child(root, CAC_NS, kind === 'CreditNote' ? 'LegalMonetaryTotal' : 'RequestedMonetaryTotal'), CBC_NS, 'PayableAmount', 24),
        leaf(root, CBC_NS, 'IssueDate', 10), child(customer, CBC_NS, 'ID').getAttribute('schemeID'), leaf(customer, CBC_NS, 'ID', 20), signed.digest].join('|') + '|';
      const fingerprints = { xml: hash(xml), zip: hash(zip), ...(cdrXml && cdrZip ? { cdrXml: hash(cdrXml), cdrZip: hash(cdrZip) } : {}) };
      return { note, permitted, prefix, requestPrefix:manifest.fileName.replace(/\.zip$/,''), proof, fingerprints, ownerRevisionSha256, files: { 'signed-xml': xml, 'submission-zip': zip, 'cdr-xml': cdrXml, 'cdr-zip': cdrZip } };
    } catch { throw new ConflictException('Originales/PDF de nota no disponibles: snapshot, original aceptado, archivos, firma/PKI/CRL o CDR requieren conciliación'); }
  }

  async download(documentId: string, kind: ProductionNotesArtifactKind, authorization?: string) {
    this.input(documentId, authorization);
    if (!['signed-xml', 'submission-zip', 'cdr-xml', 'cdr-zip'].includes(kind)) throw new BadRequestException('Formato de original de nota inválido');
    const value = await this.verified(documentId, authorization!, 'RAW');
    const bytes = value.files[kind];
    if (!bytes) throw new ConflictException('CDR de nota pendiente; no se acredita aceptación SUNAT');
    const zip = kind.endsWith('zip'), cdr = kind.startsWith('cdr');
    return { bytes: Buffer.from(bytes), fileName: `${cdr ? 'R-' : ''}${cdr || kind==='submission-zip' ? value.requestPrefix : value.prefix}.${zip ? 'zip' : 'xml'}`,
      mediaType: zip ? 'application/zip' : 'application/xml', sha256: hash(bytes),
      verification: 'ORIGINAL_BYTES_INTEGRITY_ONLY' as const, currentFiscalValidityVerified: false as const };
  }
  async pdf(documentId: string, format: PrintFormat, authorization?: string) {
    this.input(documentId, authorization);
    if (!['a4', 'ticket'].includes(format)) throw new BadRequestException('Formato PDF de nota inválido');
    const value = await this.verified(documentId, authorization!, 'PDF');
    const owner = value.permitted.printContext ?? { companyId: value.permitted.companyId };
    const { printable } = await this.presentation.presentationForDocument(value.note, authorization, owner);
    const key = hash(Buffer.from(JSON.stringify({ mode: 'PRODUCTION_NOTES_07_08', renderer: PDF_RENDERER_VERSION,
      printable, owner, format, proof: value.proof, originals: value.fingerprints, ownerRevisionSha256: value.ownerRevisionSha256 })));
    let bytes: Buffer;
    try { bytes = await this.cache.getOrRender(key, () => this.render(printable, format, value.proof)); }
    catch { throw new ServiceUnavailableException('No se pudo preparar el PDF productivo de la nota'); }
    return { bytes, fileName: `${value.prefix}-${format}-PRODUCCION.pdf`, mediaType: 'application/pdf', sha256: hash(bytes) };
  }
  onModuleDestroy() { this.cache.close(); }
}
