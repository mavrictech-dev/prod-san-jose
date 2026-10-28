import { ConflictException, Inject, Injectable, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, X509Certificate } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import forge from 'node-forge';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { assertFiscalSnapshot, buildInvoiceUbl, buildReceiptSummary, buildReceiptSummarySnapshot, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PdfPreviewCache, PDF_RENDERER_VERSION, renderProductionInvoicePdf,
  type PrintFormat, type ProductionPdfEvidence } from '@factuez/pdf-renderer';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore, MAX_ARTIFACT_BYTES } from '../infrastructure/artifact-store';
import { CertificateTrustService } from '../infrastructure/crypto/certificate-trust.service';
import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { PublicSignerArchive } from '../infrastructure/crypto/public-signer-archive';
import type { BetaIssuerPublicCertificates } from '../infrastructure/crypto/beta-owner-xml-trust';
import { certificateRucCandidates } from '../infrastructure/crypto/certificate-identity';
import { parseSafeInvoice, verifyLocalSignedInvoice, type XmlRootKind } from '../infrastructure/crypto/xml-signer.service';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import { CAC_NS, CBC_NS, child, children, leaf } from '../infrastructure/sunat/safe-xml';
import { CurrentPdfService, type PrintOwner } from './current-pdf.service';

/** Automatic PUBLIC archive populated by production preparation; no per-issuer pin input.
 * No P12, current credentials, transport, signing, database writes or artifact writes. */
export const PRODUCTION_PDF_PUBLIC_CERTIFICATES = 'PRODUCTION_PDF_PUBLIC_CERTIFICATES';
export const PRODUCTION_PDF_RENDERER = 'PRODUCTION_PDF_RENDERER';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const finalStates = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'];
const renderProductionDocument: typeof renderProductionInvoicePdf = async (snapshot, format, evidence) =>
  snapshot.documentTypeCode === '03' ? (await import('@factuez/pdf-renderer')).renderProductionReceiptPdf(snapshot, format, evidence) :
    renderProductionInvoicePdf(snapshot, format, evidence);

type Original = { documentId: string; kind: string; storageKey: string; sha256: string; sizeBytes: bigint | number; mediaType: string };

@Injectable()
export class ProductionPdfService implements OnModuleDestroy {
  private readonly cache = new PdfPreviewCache();
  constructor(private readonly prisma: PrismaService, private readonly store: ArtifactStore,
    private readonly presentation: CurrentPdfService, private readonly trust: CertificateTrustService,
    private readonly cdrTrust: CdrSignatureTrustService,
    @Optional() @Inject(PRODUCTION_PDF_PUBLIC_CERTIFICATES) private readonly certificates: BetaIssuerPublicCertificates = new PublicSignerArchive(),
    @Optional() @Inject(PRODUCTION_PDF_RENDERER) private readonly render: typeof renderProductionInvoicePdf = renderProductionDocument) {}

  private async original(documentId: string, artifact: Original, mediaType: string): Promise<Buffer> {
    if (artifact.documentId !== documentId || artifact.mediaType !== mediaType || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        BigInt(artifact.sizeBytes) < 1n || BigInt(artifact.sizeBytes) > BigInt(MAX_ARTIFACT_BYTES)) throw new Error('ORIGINAL_METADATA_INVALID');
    const bytes = await this.store.read(documentId, artifact);
    if (!Buffer.isBuffer(bytes) || BigInt(bytes.length) !== BigInt(artifact.sizeBytes) || hash(bytes) !== artifact.sha256)
      throw new Error('ORIGINAL_HASH_INVALID');
    return bytes;
  }

  private async signedIssuer(ruc: string, bytes: Buffer, unsignedXml: string, rootKind: XmlRootKind) {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed = parseSafeInvoice(xml, rootKind);
    const embedded = parsed.document.getElementsByTagNameNS(DS, 'X509Certificate');
    if (embedded.length !== 1) throw new Error('ISSUER_CERTIFICATE_REQUIRED');
    // KeyInfo is only a lookup hint. The external pinned resolver remains the authority.
    const fingerprint = new X509Certificate(Buffer.from((embedded[0].textContent ?? '').replace(/\s/g, ''), 'base64'))
      .fingerprint256.replaceAll(':', '').toLowerCase();
    const chain = structuredClone(await this.certificates.load(ruc, fingerprint));
    if (!chain || typeof chain.certificatePem !== 'string' || chain.certificatePem.length > 65536 || chain.certificatePem.includes('PRIVATE KEY') ||
        !Array.isArray(chain.chainPems) || chain.chainPems.length > 16 || chain.chainPems.some(p => typeof p !== 'string' || p.length > 65536 || p.includes('PRIVATE KEY')))
      throw new Error('ISSUER_PUBLIC_CHAIN_REQUIRED');
    // Historical limitation: this path checks issuer validity/PKI/CRL NOW, even for an old snapshot.
    // A future asOf policy must bind trusted time + archived roots, chain, signed CRLs and policy
    // version to the original XML/CDR hashes. Snapshot.issueDate alone is NOT a trusted timestamp.
    // PublicSignerArchive keeps public certificates only; it cannot establish historical PKI.
    const x509 = new X509Certificate(chain.certificatePem), certificate = forge.pki.certificateFromPem(chain.certificatePem), now = new Date();
    const metadata = { certificatePem: chain.certificatePem, chainPems: chain.chainPems,
      fingerprint: x509.fingerprint256.replaceAll(':', '').toLowerCase(), expiresAt: new Date(x509.validTo),
      selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey),
      digitalSignature: (certificate.getExtension('keyUsage') as { digitalSignature?: boolean } | null)?.digitalSignature === true,
      subjectRucCandidates: certificateRucCandidates(certificate.subject.attributes) };
    if (fingerprint !== metadata.fingerprint || x509.ca || metadata.selfSigned || !metadata.digitalSignature ||
        x509.publicKey.asymmetricKeyType !== 'rsa' || (x509.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        now < new Date(x509.validFrom) || now >= metadata.expiresAt || metadata.subjectRucCandidates.length !== 1 ||
        metadata.subjectRucCandidates[0] !== ruc) throw new Error('ISSUER_IDENTITY_INVALID');
    const proof = await this.trust.evaluate(metadata, ruc, now);
    if (proof.profile !== 'OFFLINE-PINNED-ROOTS-CRL-v1' || proof.chainValid !== true || proof.identityMatched !== true ||
        proof.revocation !== 'VERIFIED_OFFLINE_CRL' || !Array.isArray(proof.blockers) || proof.blockers.length ||
        proof.certificateFingerprint !== fingerprint || proof.checkedAt !== now.toISOString() || !/^[a-f0-9]{64}$/.test(proof.trustStoreSha256 ?? ''))
      throw new Error('ISSUER_CHAIN_CRL_NOT_VERIFIED');
    // Reconstruct solely to compare all authenticated fiscal facts; never archive/sign/emit it.
    const digestValue = verifyLocalSignedInvoice(xml, chain.certificatePem, unsignedXml, rootKind);
    return { digestValue, fingerprint, root: parsed.root };
  }

  private async issuer(snapshot: FiscalDocumentSnapshot, bytes: Buffer, expectedDigest: string | null) {
    const { digestValue, fingerprint, root } = await this.signedIssuer(snapshot.issuer.identityNumber, bytes,
      buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }), 'Invoice');
    if (digestValue !== expectedDigest) throw new Error('ARCHIVED_DIGEST_MISMATCH');
    const customer = child(child(child(root, CAC_NS, 'AccountingCustomerParty'), CAC_NS, 'Party'), CAC_NS, 'PartyIdentification');
    const identity = child(customer, CBC_NS, 'ID');
    const supplier = child(child(child(root, CAC_NS, 'AccountingSupplierParty'), CAC_NS, 'Party'), CAC_NS, 'PartyIdentification');
    const fullNumber = leaf(root, CBC_NS, 'ID', 40), separator = fullNumber.indexOf('-');
    const qrPayload = [leaf(supplier, CBC_NS, 'ID', 11), leaf(root, CBC_NS, 'InvoiceTypeCode', 2),
      fullNumber.slice(0, separator), fullNumber.slice(separator + 1),
      leaf(child(root, CAC_NS, 'TaxTotal'), CBC_NS, 'TaxAmount', 24),
      leaf(child(root, CAC_NS, 'LegalMonetaryTotal'), CBC_NS, 'PayableAmount', 24), leaf(root, CBC_NS, 'IssueDate', 10),
      identity.getAttribute('schemeID'), leaf(customer, CBC_NS, 'ID', 20), digestValue].join('|') + '|';
    return { digestValue, qrPayload, fingerprint };
  }

  private one(artifacts: Original[], kind: string, required = true) {
    const found = artifacts.filter(a => a.kind === kind);
    if (found.length > 1 || required && found.length !== 1) throw new Error('ORIGINAL_REQUIRED');
    return found[0];
  }
  private manifestFile(artifact: Original, stored: { storageKey: string; sha256: string; sizeBytes: number } | undefined) {
    if (!stored || stored.storageKey !== artifact.storageKey || stored.sha256 !== artifact.sha256 ||
        !Number.isSafeInteger(stored.sizeBytes) || BigInt(stored.sizeBytes) !== BigInt(artifact.sizeBytes)) throw new Error('RC_MANIFEST_ARTIFACT_MISMATCH');
  }
  private async cdr(zip: Buffer, xml: Buffer, ruc: string, reference: string, type: '01' | 'RC') {
    const name = `R-${ruc}-${type === '01' ? '01-' : ''}${reference}.xml`;
    const strict = productionTransportXml(zip, name, true);
    const parsed = parseCdrZip(zip, { fileName: name, issuerRuc: ruc, reference });
    if (!strict.xml.equals(xml) || !parsed.xml.equals(xml) || !(await this.cdrTrust.verify(xml))) throw new Error('CDR_ORIGINAL_NOT_VERIFIED');
    const root = parseSafeInvoice(new TextDecoder('utf-8', { fatal: true }).decode(xml), 'ApplicationResponse').root;
    const response = child(root, CAC_NS, 'DocumentResponse'), documentReference = child(response, CAC_NS, 'DocumentReference');
    const types = children(documentReference, CBC_NS, 'DocumentTypeCode'), responseId = children(child(response, CAC_NS, 'Response'), CBC_NS, 'ReferenceID');
    if (types.length > 1 || types.length === 1 && leaf(documentReference, CBC_NS, 'DocumentTypeCode', 2) !== type ||
        responseId.length > 1 || responseId.length === 1 && leaf(child(response, CAC_NS, 'Response'), CBC_NS, 'ReferenceID', 40) !== reference)
      throw new Error('CDR_DOCUMENT_MISMATCH');
    return parsed;
  }

  /** Production's initial single-member alta RC only. No summary status/HTTP Boolean is evidence.
   * The immutable batch and canonical signed RC must each contain exactly this full snapshot.
   * All originals, metadata and PKI are re-read before every cache lookup, including pending PDFs. */
  private async receiptSummary(snapshot: FiscalDocumentSnapshot,
    document: { billingEventId: string; status: string; artifacts: Original[] }, individualXml: Buffer,
    individualDigest: string, individualFingerprint: string): Promise<{ evidence: ProductionPdfEvidence['receiptSummary']; status: ProductionPdfEvidence['status'];
      responseCode?: string; cdrDescription?: string; cdrNotes?: string[] }> {
    const submissions = await this.prisma.sunatSubmission.findMany({ where: { documentId: snapshot.documentId, channel: 'SOAP_SEND_SUMMARY' }, take: 2 });
    if (submissions.length !== 1) throw new Error('RC_UNIQUE_SUBMISSION_REQUIRED');
    const submission = submissions[0]!;
    if (submission.documentId !== snapshot.documentId || submission.channel !== 'SOAP_SEND_SUMMARY' || !submission.batchId ||
        submission.idempotencyKey !== `production:${snapshot.documentId}:v1` || !submission.errorMessage || submission.errorMessage.length > 262144)
      throw new Error('RC_PRODUCTION_SUBMISSION_REQUIRED');
    const metadata = JSON.parse(submission.errorMessage) as { version: number; eventId: string; correlationId: string; prepared?: import('./beta-issuance.repository').BetaManifest };
    const manifest = metadata?.prepared;
    if (metadata?.version !== 1 || !metadata.eventId || metadata.eventId !== document.billingEventId || !metadata.correlationId || !manifest ||
        !/^RC-\d{8}-[1-9]\d{0,4}$/.test(manifest.reference) || manifest.fingerprint !== individualFingerprint || manifest.digest !== individualDigest ||
        !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 || manifest.documentSnapshotSha256 !== fiscalSnapshotSha256(snapshot))
      throw new Error('RC_EXACT_PREPARED_MANIFEST_REQUIRED');
    // Historical business reconstruction uses the fixed RC day, never the download day.
    // This clock is ONLY for reconstructing the immutable batch, never issuer/CDR PKI or CRL.
    const day = manifest.reference.slice(3, 11);
    const reconstructionTime = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T23:59:59.999-05:00`;
    const expected = buildReceiptSummarySnapshot(snapshot, manifest.reference, reconstructionTime);
    const batch = await this.prisma.fiscalBatch.findUnique({ where: { summaryId: snapshot.documentId }, include: { artifacts: true } });
    if (!batch || batch.summaryId !== snapshot.documentId || batch.id !== submission.batchId || batch.environment !== 'PRODUCTION' ||
        batch.identifier !== manifest.reference || batch.issuerRuc !== snapshot.issuer.identityNumber || batch.billingEventId !== metadata.eventId ||
        !isDeepStrictEqual(batch.immutablePayload, JSON.parse(JSON.stringify(expected))) || manifest.requestOwnerId !== expected.documentId ||
        manifest.fileName !== `${snapshot.issuer.identityNumber}-${manifest.reference}.zip` || manifest.requestOwnerId === snapshot.documentId)
      throw new Error('RC_BATCH_MEMBER_BINDING_MISMATCH');
    const one = (kind: string, required = true) => this.one(document.artifacts, kind, required);
    const batchOne = (kind: string, required = true) => {
      const found = batch.artifacts.filter(a => a.kind === kind);
      if (found.length > 1 || required && found.length !== 1) throw new Error('RC_BATCH_ORIGINAL_REQUIRED');
      const artifact = found[0];
      if (artifact && artifact.batchId !== batch.id) throw new Error('RC_BATCH_ARTIFACT_OWNER_MISMATCH');
      return artifact;
    };
    // Files are stored under the deterministic technical owner UUID, not the database batch ID.
    const batchRead = (artifact: NonNullable<ReturnType<typeof batchOne>>, media: string) =>
      this.original(expected.documentId, { ...artifact, documentId: expected.documentId }, media);
    const memberXml = one('SIGNED_XML')!, memberZip = one('SUBMISSION_ZIP')!;
    this.manifestFile(memberXml, manifest.documentXml); this.manifestFile(memberZip, manifest.individualXmlZip);
    const individualZip = await this.original(snapshot.documentId, memberZip, 'application/zip');
    if (!productionTransportXml(individualZip, `${snapshot.issuer.identityNumber}-03-${snapshot.fullNumber}.xml`).xml.equals(individualXml))
      throw new Error('RC_INDIVIDUAL_XML_ZIP_MISMATCH');
    const summaryXmlArtifact = batchOne('SIGNED_XML')!, summaryZipArtifact = batchOne('SUBMISSION_ZIP')!;
    this.manifestFile({ ...summaryXmlArtifact, documentId: expected.documentId }, manifest.xml);
    this.manifestFile({ ...summaryZipArtifact, documentId: expected.documentId }, manifest.zip);
    if (submission.requestArtifactKey !== manifest.zip.storageKey || memberXml.storageKey === summaryXmlArtifact.storageKey ||
        memberZip.storageKey === summaryZipArtifact.storageKey) throw new Error('RC_REQUEST_ARTIFACT_MISMATCH');
    const summaryXml = await batchRead(summaryXmlArtifact, 'application/xml'), summaryZip = await batchRead(summaryZipArtifact, 'application/zip');
    if (!productionTransportXml(summaryZip, manifest.fileName.replace(/\.zip$/, '.xml')).xml.equals(summaryXml)) throw new Error('RC_SUMMARY_XML_ZIP_MISMATCH');
    const summaryProof = await this.signedIssuer(snapshot.issuer.identityNumber, summaryXml,
      buildReceiptSummary(snapshot, manifest.reference, 'REAL_PREPARATION'), 'SummaryDocuments');
    if (summaryProof.fingerprint !== manifest.fingerprint) throw new Error('RC_SIGNER_MISMATCH');
    const evidence: NonNullable<ProductionPdfEvidence['receiptSummary']> = { identifier: manifest.reference,
      summaryXmlSha256: hash(summaryXml), summaryZipSha256: hash(summaryZip),
      individualXmlSha256: hash(individualXml), individualZipSha256: hash(individualZip) };
    if (!finalStates.includes(document.status)) {
      if (batch.status !== document.status || finalStates.includes(batch.status) || submission.errorCode === 'DONE' || submission.result === 'SUCCESS' ||
          batchOne('CDR_XML', false) || batchOne('CDR_ZIP', false) || one('CDR_XML', false) || one('CDR_ZIP', false))
        throw new Error('RC_FINAL_RECONCILIATION_REQUIRED');
      return { evidence, status: 'PENDING' };
    }
    if (batch.status !== document.status || submission.errorCode !== 'DONE' || !submission.completedAt ||
        submission.result !== (document.status === 'REJECTED' ? 'BUSINESS_ERROR' : 'SUCCESS')) throw new Error('RC_FINAL_STATUS_MISMATCH');
    const cdrXmlArtifact = batchOne('CDR_XML')!, cdrZipArtifact = batchOne('CDR_ZIP')!;
    const cdrXml = await batchRead(cdrXmlArtifact, 'application/xml'), cdrZip = await batchRead(cdrZipArtifact, 'application/zip');
    // Issuance also archives identical CDR copies under the individual document. Require both to agree.
    const docCdrXml = one('CDR_XML')!, docCdrZip = one('CDR_ZIP')!;
    if (submission.responseArtifactKey !== docCdrZip.storageKey ||
        !(await this.original(snapshot.documentId, docCdrXml, 'application/xml')).equals(cdrXml) ||
        !(await this.original(snapshot.documentId, docCdrZip, 'application/zip')).equals(cdrZip)) throw new Error('RC_CDR_COPY_OR_SUBMISSION_MISMATCH');
    const parsed = await this.cdr(cdrZip, cdrXml, snapshot.issuer.identityNumber, manifest.reference, 'RC');
    if (parsed.status !== document.status) throw new Error('RC_CDR_STATE_MISMATCH');
    return { evidence: { ...evidence, cdrXmlSha256: hash(cdrXml), cdrZipSha256: hash(cdrZip) }, status: parsed.status,
      responseCode: parsed.code, cdrDescription: parsed.description, cdrNotes: parsed.notes };
  }

  /** Internal owner-to-owner evidence, not an HTTP authorization endpoint. No PDF, cache,
   * P12 or network. Original owner must authorize the caller before requesting this proof. */
  async acceptedArchive(authorizedSnapshot: FiscalDocumentSnapshot) {
    const snapshot=structuredClone(authorizedSnapshot);
    if(snapshot.environment!=='PRODUCTION'||!['01','03'].includes(snapshot.documentTypeCode))throw new ConflictException('Aceptación limitada a documentos 01/03 propios.');
    assertFiscalSnapshot(snapshot,{mode:'REAL_PREPARATION'});
    const document=await this.prisma.fiscalDocument.findUnique({where:{documentId:snapshot.documentId},include:{artifacts:true,submissions:true}});
    if(!document||document.environment!=='PRODUCTION'||document.documentId!==snapshot.documentId||document.issuerRuc!==snapshot.issuer.identityNumber||document.documentType!==snapshot.documentTypeCode||
       document.series!==snapshot.series||document.number!==BigInt(snapshot.number)||!isDeepStrictEqual(document.immutablePayload,JSON.parse(JSON.stringify(snapshot)))||
       !['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(document.status)||!document.acceptedAt||!Number.isFinite(document.acceptedAt.getTime())||document.acceptedAt.getTime()<Date.parse(snapshot.issueDate)||document.acceptedAt.getTime()>Date.now())
      throw new ConflictException('Aceptación del original propio pendiente o inconsistente.');
    const one=(kind:string)=>this.one(document.artifacts as Original[],kind)!;
    const xmlArtifact=one('SIGNED_XML'),zipArtifact=one('SUBMISSION_ZIP'),cdrXmlArtifact=one('CDR_XML'),cdrZipArtifact=one('CDR_ZIP');
    const xml=await this.original(snapshot.documentId,xmlArtifact,'application/xml'),zip=await this.original(snapshot.documentId,zipArtifact,'application/zip');
    if(!productionTransportXml(zip,`${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}.xml`).xml.equals(xml))throw new ConflictException('XML/ZIP individual inconsistente.');
    const signer=await this.issuer(snapshot,xml,document.digestValue);
    let summary:ProductionPdfEvidence['receiptSummary'];
    if(snapshot.documentTypeCode==='03'){
      const result=await this.receiptSummary(snapshot,document,xml,signer.digestValue,signer.fingerprint);
      if(result.status!==document.status||!result.evidence?.cdrXmlSha256||!result.evidence.cdrZipSha256)throw new ConflictException('CDR RC aceptado no vinculado.');
      summary=result.evidence;
    }else{
      const submissions=document.submissions.filter(s=>s.idempotencyKey===`production:${snapshot.documentId}:v1`&&s.channel==='SOAP_SEND_BILL'&&s.result==='SUCCESS'&&s.errorCode==='DONE'&&s.completedAt);
      if(submissions.length!==1||submissions[0].requestArtifactKey!==zipArtifact.storageKey||submissions[0].responseArtifactKey!==cdrZipArtifact.storageKey)throw new ConflictException('Envío productivo exacto requerido.');
      const result=await this.cdr(await this.original(snapshot.documentId,cdrZipArtifact,'application/zip'),await this.original(snapshot.documentId,cdrXmlArtifact,'application/xml'),snapshot.issuer.identityNumber,snapshot.fullNumber,'01');
      if(result.status!==document.status)throw new ConflictException('Estado original/CDR inconsistente.');
    }
    return {profile:snapshot.documentTypeCode==='01'?'PRODUCTION-01-ARCHIVE-v1' as const:'PRODUCTION-03-RC-ARCHIVE-v1' as const,documentId:snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(snapshot),
      signedXmlSha256:xmlArtifact.sha256,cdrXmlSha256:cdrXmlArtifact.sha256,cdrZipSha256:cdrZipArtifact.sha256,acceptedAt:document.acceptedAt.toISOString(),checkedAt:new Date().toISOString(),...(summary?{receiptSummary:summary}:{})};
  }

  /** Internal delivery path: Billing authorization must succeed on EVERY call before entering here. */
  async document(authorizedSnapshot: FiscalDocumentSnapshot, format: PrintFormat, authorization: string, binding?: PrintOwner): Promise<Buffer> {
    const snapshot = structuredClone(authorizedSnapshot);
    try {
      if (snapshot.environment !== 'PRODUCTION' || !['01', '03'].includes(snapshot.documentTypeCode) || snapshot.currencyCode !== 'PEN' ||
          !['a4', 'ticket'].includes(format)) throw new Error('PROFILE');
      // Existing REAL_PREPARATION validator uses today's clock (future-date guard); no historical override.
      assertFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
    } catch { throw new ConflictException('PDF productivo limitado a factura/boleta 01/03 PEN con snapshot fiscal válido.'); }
    const document = await this.prisma.fiscalDocument.findUnique({ where: { documentId: snapshot.documentId }, include: { artifacts: true } });
    if (!document || document.documentId !== snapshot.documentId || document.environment !== 'PRODUCTION' ||
        document.issuerRuc !== snapshot.issuer.identityNumber || document.documentType !== snapshot.documentTypeCode || document.series !== snapshot.series ||
        document.number !== BigInt(snapshot.number) || !isDeepStrictEqual(document.immutablePayload, JSON.parse(JSON.stringify(snapshot))))
      throw new ConflictException('Snapshot productivo inconsistente con el documento propio de SUNAT.');
    if (!finalStates.includes(document.status) && (!['QUEUED', 'BUILDING', 'SIGNED', 'SUBMITTED', 'PROCESSING', 'RETRYABLE_ERROR', 'PERMANENT_ERROR'].includes(document.status) || document.acceptedAt))
      throw new ConflictException('Estado fiscal inconsistente; requiere conciliación.');
    let evidence: ProductionPdfEvidence;
    try {
      const artifacts = document.artifacts as Original[];
      const one = (kind: string, required = true) => {
        const found = artifacts.filter(a => a.kind === kind);
        if (found.length > 1 || required && found.length !== 1) throw new Error('ORIGINAL_REQUIRED');
        return found[0];
      };
      const xml = await this.original(snapshot.documentId, one('SIGNED_XML')!, 'application/xml');
      const issuer = await this.issuer(snapshot, xml, document.digestValue);
      evidence = { environment: 'PRODUCTION', status: 'PENDING', digestValue: issuer.digestValue, qrPayload: issuer.qrPayload };
      if (snapshot.documentTypeCode === '03') {
        const result = await this.receiptSummary(snapshot, document, xml, issuer.digestValue, issuer.fingerprint);
        const { evidence: receiptSummary, ...outcome } = result;
        evidence = { ...evidence, ...outcome, receiptSummary };
      } else if (finalStates.includes(document.status)) {
        const zip = await this.original(snapshot.documentId, one('CDR_ZIP')!, 'application/zip');
        const originalXml = await this.original(snapshot.documentId, one('CDR_XML')!, 'application/xml');
        const parsed = await this.cdr(zip, originalXml, snapshot.issuer.identityNumber, snapshot.fullNumber, '01');
        if (parsed.status !== document.status) throw new Error('CDR_STATE_OR_DOCUMENT_MISMATCH');
        evidence = { ...evidence, status: parsed.status, responseCode: parsed.code, cdrDescription: parsed.description, cdrNotes: parsed.notes };
      } else if (one('CDR_ZIP', false) || one('CDR_XML', false)) throw new Error('CDR_RECONCILIATION_REQUIRED');
    } catch {
      throw new ConflictException('PDF productivo no disponible: XML firmado, cadena/CRL o CDR original faltante, inválido o pendiente de conciliación. No se acredita aceptación SUNAT.');
    }
    // Current design/logo only; immutable facts remain untouched. All verification precedes cache.
    const { printable, owner } = await this.presentation.presentationForDocument(snapshot, authorization, binding);
    const key = hash(JSON.stringify({ renderer: PDF_RENDERER_VERSION, mode: `PRODUCTION_${snapshot.documentTypeCode}_PEN`, owner, printable, format, evidence }));
    try { return await this.cache.getOrRender(key, () => this.render(printable, format, evidence)); }
    catch { throw new ServiceUnavailableException('No se pudo preparar la representación fiscal productiva. Reintente.'); }
  }
  onModuleDestroy() { this.cache.close(); }
}
