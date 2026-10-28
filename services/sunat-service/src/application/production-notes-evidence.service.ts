import { ProductionPdfService } from './production-pdf.service';
import { Injectable, Optional } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import type { FiscalDocumentSnapshot, ProductionNotesExtendedAcceptance as ProductionNotesAcceptance } from '@factuez/contracts';
import { assertProductionNotesExtendedOriginal as assertProductionNotesOriginal, buildInvoiceUbl, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { PublicSignerArchive } from '../infrastructure/crypto/public-signer-archive';
import { CertificateTrustService } from '../infrastructure/crypto/certificate-trust.service';
import { certificateRucCandidates } from '../infrastructure/crypto/certificate-identity';
import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { parseSafeInvoice, verifyLocalSignedInvoice, type XmlRootKind } from '../infrastructure/crypto/xml-signer.service';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { CAC_NS, CBC_NS, child, children, leaf } from '../infrastructure/sunat/safe-xml';
@Injectable()
export class ProductionNotesEvidenceService {
    constructor(private readonly prisma: PrismaService, private readonly store: ArtifactStore, private readonly publicSigners: PublicSignerArchive, private readonly trust: CertificateTrustService, private readonly cdrTrust: CdrSignatureTrustService, @Optional() private readonly archives?: ProductionPdfService) { }
    async signed(ruc: string, xml: Buffer, unsigned: string, kind: XmlRootKind) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(xml), parsed = parseSafeInvoice(text, kind);
        const certs = parsed.document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
        if (certs.length !== 1)
            throw Error('Firmante único requerido');
        const fingerprint = new X509Certificate(Buffer.from((certs[0].textContent ?? '').replace(/\s/g, ''), 'base64')).fingerprint256.replaceAll(':', '').toLowerCase();
        const chain = await this.publicSigners.load(ruc, fingerprint), x509 = new X509Certificate(chain.certificatePem), cert = forge.pki.certificateFromPem(chain.certificatePem), now = new Date();
        const metadata = { ...chain, fingerprint: x509.fingerprint256.replaceAll(':', '').toLowerCase(), expiresAt: new Date(x509.validTo),
            selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey), digitalSignature: (cert.getExtension('keyUsage') as {
                digitalSignature?: boolean;
            } | null)?.digitalSignature === true,
            subjectRucCandidates: certificateRucCandidates(cert.subject.attributes) };
        if (metadata.fingerprint !== fingerprint || x509.ca || metadata.selfSigned || !metadata.digitalSignature || x509.publicKey.asymmetricKeyType !== 'rsa' || (x509.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
            now < new Date(x509.validFrom) || now >= metadata.expiresAt || metadata.subjectRucCandidates.length !== 1 || metadata.subjectRucCandidates[0] !== ruc)
            throw Error('Firmante original inválido');
        const proof = await this.trust.evaluate(metadata, ruc, now);
        if (proof.profile !== 'OFFLINE-PINNED-ROOTS-CRL-v1' || !proof.chainValid || !proof.identityMatched || proof.revocation !== 'VERIFIED_OFFLINE_CRL' || proof.blockers.length ||
            proof.certificateFingerprint !== fingerprint || proof.checkedAt !== now.toISOString() || !/^[a-f0-9]{64}$/.test(proof.trustStoreSha256 ?? ''))
            throw Error('Confianza actual del firmante no acreditada');
        return { fingerprint, digest: verifyLocalSignedInvoice(text, chain.certificatePem, unsigned, kind) };
    }
    async cdr(zip: Buffer, xml: Buffer, ruc: string, type: '01' | '07' | '08' | 'RC', reference: string) {
        const name = 'R-' + ruc + '-' + (type==='RC'?'':type+'-') + reference + '.xml';
        const packed = productionTransportXml(zip, name, true), parsed = parseCdrZip(zip, { fileName: name, issuerRuc: ruc, reference });
        if (!packed.xml.equals(xml) || !parsed.xml.equals(xml) || !await this.cdrTrust.verify(xml))
            throw Error('CDR exacto y confianza requeridos');
        const root = parseSafeInvoice(new TextDecoder('utf-8', { fatal: true }).decode(xml), 'ApplicationResponse').root;
        const response = child(root, CAC_NS, 'DocumentResponse'), ref = child(response, CAC_NS, 'DocumentReference'), types = children(ref, CBC_NS, 'DocumentTypeCode');
        if (types.length > 1 || types.length === 1 && leaf(ref, CBC_NS, 'DocumentTypeCode', 2) !== type)
            throw Error('CDR de otro tipo');
        const inner = child(response, CAC_NS, 'Response'), ids = children(inner, CBC_NS, 'ReferenceID');
        if (ids.length > 1 || ids.length === 1 && leaf(inner, CBC_NS, 'ReferenceID', 40) !== reference)
            throw Error('CDR de otra referencia');
        return parsed;
    }
    async original(snapshot: FiscalDocumentSnapshot): Promise<ProductionNotesAcceptance> {
        assertProductionNotesOriginal(snapshot);
        if(snapshot.documentTypeCode==='03'){
            if(!this.archives)throw Error('Verificador de archivo RC no integrado');
            return await this.archives.acceptedArchive(snapshot) as unknown as ProductionNotesAcceptance;
        }
        const doc = await this.prisma.fiscalDocument.findUnique({ where: { documentId: snapshot.documentId }, include: { artifacts: true, submissions: true } });
        if (!doc || doc.environment !== 'PRODUCTION' || doc.documentType !== '01' || doc.documentId !== snapshot.documentId || doc.series !== snapshot.series || doc.number !== BigInt(snapshot.number) || doc.issuerRuc !== snapshot.issuer.identityNumber || fiscalSnapshotSha256(doc.immutablePayload) !== fiscalSnapshotSha256(snapshot) ||
            !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(doc.status) || !doc.acceptedAt)
            throw Error('Factura original propia aceptada requerida');
        const one = (kind: string) => { const rows = doc.artifacts.filter(a => a.kind === kind); if (rows.length !== 1)
            throw Error('Original fiscal único requerido'); return rows[0]; };
        const signed = one('SIGNED_XML'), request = one('SUBMISSION_ZIP'), cdrXml = one('CDR_XML'), cdrZip = one('CDR_ZIP');
        const submissions = doc.submissions.filter(s => s.idempotencyKey === 'production:' + snapshot.documentId + ':v1' && s.errorCode === 'DONE' && s.result === 'SUCCESS' && s.completedAt);
        if (submissions.length !== 1 || submissions[0].requestArtifactKey !== request.storageKey || submissions[0].responseArtifactKey !== cdrZip.storageKey)
            throw Error('Envío original productivo exacto requerido');
        const xml = await this.store.read(doc.documentId, signed), zip = await this.store.read(doc.documentId, request);
        if (!productionTransportXml(zip, doc.issuerRuc + '-01-' + snapshot.fullNumber + '.xml').xml.equals(xml))
            throw Error('Paquete original inconsistente');
        const proof = await this.signed(doc.issuerRuc, xml, buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }), 'Invoice');
        if (proof.digest !== doc.digestValue)
            throw Error('Digest original inconsistente');
        const result = await this.cdr(await this.store.read(doc.documentId, cdrZip), await this.store.read(doc.documentId, cdrXml), doc.issuerRuc, '01', snapshot.fullNumber);
        if (result.status !== doc.status)
            throw Error('Resultado original inconsistente');
        return { profile: 'PRODUCTION-01-ARCHIVE-v1', documentId: snapshot.documentId, snapshotSha256: fiscalSnapshotSha256(snapshot), signedXmlSha256: signed.sha256,
            cdrXmlSha256: cdrXml.sha256, cdrZipSha256: cdrZip.sha256, acceptedAt: doc.acceptedAt.toISOString(), checkedAt: new Date().toISOString() };
    }
}
