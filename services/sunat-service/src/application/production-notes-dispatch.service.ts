import { isDeepStrictEqual } from 'node:util';
import { productionNotesUnsigned, assertProductionNotesContext, buildProductionNotesRc, productionNotesUsesRc, type ProductionNotesContext } from './production-notes-rc';
import { Injectable } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { ProductionNotesDispatchRepository, type ProductionNotesDispatch, type ProductionNotesManifest } from './production-notes-dispatch.repository';
import { ProductionNotesPolicyService } from './production-notes-policy.service';
import { ProductionNotesEvidenceService } from './production-notes-evidence.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { CertificateInspectionService } from '../infrastructure/crypto/certificate-inspection.service';
import { CertificateTrustService } from '../infrastructure/crypto/certificate-trust.service';
import { PublicSignerArchive } from '../infrastructure/crypto/public-signer-archive';
import { verifyLocalSignedInvoice } from '../infrastructure/crypto/xml-signer.service';
import { XsdValidationService } from '../infrastructure/sunat/xsd-validation.service';
import { BoundedSoapAdapter, SoapSubmissionError } from '../infrastructure/sunat/bounded-soap.adapter';
import { createProductionSoapAuthorization } from '../infrastructure/sunat/production-soap-authorization';
import { productionTransportXml } from '../infrastructure/sunat/production-transport-zip';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import type { prepareProductionNotesXml } from './production-notes-crypto';
@Injectable()
export class ProductionNotesDispatchService {
    constructor(private readonly repository: ProductionNotesDispatchRepository, private readonly policy: ProductionNotesPolicyService, private readonly evidence: ProductionNotesEvidenceService, private readonly store: ArtifactStore, private readonly vault: SecretVault, private readonly inspection: CertificateInspectionService, private readonly trust: CertificateTrustService, private readonly publicSigners: PublicSignerArchive, private readonly xsd: XsdValidationService) { }
    protected async sign(snapshot: ProductionNotesDispatch['payload']['payload']['snapshot'], bytes: Buffer, password: string, context?: ProductionNotesContext): Promise<ReturnType<typeof prepareProductionNotesXml>> {
        return new Promise((resolve, reject) => {
            const worker = new Worker(join(__dirname, 'production-notes-crypto.worker.js'), { workerData: { snapshot, bytes, password, context }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
            let settled = false;
            const finish = (error?: Error, value?: ReturnType<typeof prepareProductionNotesXml>) => { if (settled)
                return; settled = true; clearTimeout(timer); void worker.terminate().then(() => error ? reject(error) : resolve({ ...value!, zip: Buffer.from(value!.zip), ...(value!.rc ? {rc:{...value!.rc,zip:Buffer.from(value!.rc.zip)}}:{}) }), () => reject(Error('Worker interrumpido'))); };
            const timer = setTimeout(() => finish(Error('Worker ocupado')), 10000);
            worker.once('message', v => v.ok ? finish(undefined, v.value) : finish(Error('Firma inválida')));
            worker.once('error', () => finish(Error('Worker no disponible')));
            worker.once('exit', () => finish(Error('Worker interrumpido')));
        });
    }
    private async authorize(row: ProductionNotesDispatch) {
        const p = row.payload.payload;
        assertProductionNotesContext(p.snapshot, p);
        if (fiscalSnapshotSha256(p.snapshot) !== row.snapshotSha256)
            throw Error('Snapshot de envío cambió');
        await this.policy.current(p.snapshot.issuer.identityNumber, p.admission);
        const fresh = await this.evidence.original(p.original), frozen = p.snapshot.originalAcceptance;
        if (fresh.profile!==frozen.profile || !isDeepStrictEqual('receiptSummary' in fresh ? fresh.receiptSummary : undefined, 'receiptSummary' in frozen ? frozen.receiptSummary : undefined)) throw Error('Archivo original RC cambió');
        for (const key of ['documentId', 'snapshotSha256', 'signedXmlSha256', 'cdrXmlSha256', 'cdrZipSha256', 'acceptedAt'] as const)
            if (fresh[key] !== frozen[key])
                throw Error('Original aceptado cambió');
    }
    private async prepare(row: ProductionNotesDispatch): Promise<ProductionNotesManifest> {
        const note = row.payload.payload.snapshot, aad = { ruc: note.issuer.identityNumber, environment: 'PRODUCTION' }, current = await this.policy.current(aad.ruc, row.payload.payload.admission), c = current.credentials;
        if (!c.certificateCipher || !c.certificatePasswordCipher)
            throw Error('Certificado no preparado');
        const bytes = this.vault.open(c.certificateCipher, { ...aad, field: 'certificate' });
        let password: Buffer | undefined;
        try {
            password = this.vault.open(c.certificatePasswordCipher, { ...aad, field: 'certificatePassword' });
            const metadata = await this.inspection.inspect(bytes, password.toString()), now = new Date(), proof = await this.trust.evaluate(metadata, aad.ruc, now);
            if (metadata.fingerprint !== current.grant.fingerprint || proof.profile !== 'OFFLINE-PINNED-ROOTS-CRL-v1' || !proof.chainValid || !proof.identityMatched || proof.revocation !== 'VERIFIED_OFFLINE_CRL' || proof.blockers.length || proof.checkedAt !== now.toISOString() || proof.certificateFingerprint !== metadata.fingerprint || !/^[a-f0-9]{64}$/.test(proof.trustStoreSha256 ?? ''))
                throw Error('Confianza de firma pendiente');
            const identifier=productionNotesUsesRc(note)?await this.repository.reserveRc(row):undefined;
            if(identifier)row.rcIdentifier=identifier;
            const context={...row.payload.payload,identifier};
            const result = await this.sign(note, bytes, password.toString(), context), unsigned = productionNotesUnsigned(note, context), kind = note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
            if (result.certificateFingerprintSha256 !== metadata.fingerprint || verifyLocalSignedInvoice(result.xml, metadata.certificatePem, unsigned, kind) !== result.digestValue || result.fileName !== aad.ruc + '-' + note.documentTypeCode + '-' + note.fullNumber || !productionTransportXml(result.zip, result.fileName + '.xml').xml.equals(Buffer.from(result.xml)))
                throw Error('Paquete firmado no corresponde al snapshot');
            const xsdEvidence = await this.xsd.validate(result.xml, kind);
            let rc:ProductionNotesManifest['rc'];
            if(identifier){
              const summary=result.rc;
              if(!summary||summary.identifier!==identifier||summary.fileName!==aad.ruc+'-'+identifier||summary.certificateFingerprintSha256!==metadata.fingerprint||verifyLocalSignedInvoice(summary.xml,metadata.certificatePem,buildProductionNotesRc(note,identifier,context),'SummaryDocuments')!==summary.digestValue||!productionTransportXml(summary.zip,summary.fileName+'.xml').xml.equals(Buffer.from(summary.xml)))throw Error('Firma RC ajena a la nota');
              const summaryXsd=await this.xsd.validate(summary.xml,'SummaryDocuments');
              rc={identifier,xml:await this.store.put(row.documentId,summary.fileName+'.xml',Buffer.from(summary.xml)),individualZip:await this.store.put(row.documentId,result.fileName+'.zip',result.zip),digest:summary.digestValue,xsdEvidence:summaryXsd};
            }else if(result.rc)throw Error('RC inesperado');
            await this.authorize(row);
            await this.publicSigners.archive(aad.ruc, metadata);
            return { fileName: (result.rc?.fileName ?? result.fileName) + '.zip', xml: await this.store.put(row.documentId, result.fileName + '.xml', Buffer.from(result.xml)), zip: await this.store.put(row.documentId, (result.rc?.fileName ?? result.fileName) + '.zip', result.rc?.zip ?? result.zip), digest: result.digestValue, fingerprint: metadata.fingerprint, revision: c.revision, xsdEvidence, ...(rc?{rc}:{}) };
        }
        finally {
            bytes.fill(0);
            password?.fill(0);
        }
    }
    private async archived(row: ProductionNotesDispatch, manifest: ProductionNotesManifest) {
        const note=row.payload.payload.snapshot,context=row.payload.payload,rc=manifest.rc,kind=note.documentTypeCode==='07'?'CreditNote':'DebitNote';
        const xml=await this.store.read(row.documentId,manifest.xml),zip=await this.store.read(row.documentId,manifest.zip);
        const prefix=note.issuer.identityNumber+'-'+note.documentTypeCode+'-'+note.fullNumber;
        if(manifest.revision!==context.admission.credentialRevision||manifest.fingerprint!==context.admission.certificateFingerprint||productionNotesUsesRc(note)!==Boolean(rc))throw Error('Archivo productivo inconsistente');
        const individualZip=rc?await this.store.read(row.documentId,rc.individualZip):zip;
        if(!productionTransportXml(individualZip,prefix+'.xml').xml.equals(xml))throw Error('Paquete individual inconsistente');
        const signed=await this.evidence.signed(note.issuer.identityNumber,xml,productionNotesUnsigned(note,context),kind);
        if(signed.digest!==manifest.digest||signed.fingerprint!==manifest.fingerprint)throw Error('Firmante archivado inconsistente');
        if((await this.xsd.validate(xml,kind)).xmlSha256!==manifest.xml.sha256)throw Error('XSD individual no corresponde');
        if(rc){
          const expectedName=note.issuer.identityNumber+'-'+rc.identifier;
          if(row.rcIdentifier!==rc.identifier||manifest.fileName!==expectedName+'.zip')throw Error('Reserva RC inconsistente');
          const summary=await this.store.read(row.documentId,rc.xml);
          if(!productionTransportXml(zip,expectedName+'.xml').xml.equals(summary))throw Error('Paquete RC inconsistente');
          const proof=await this.evidence.signed(note.issuer.identityNumber,summary,buildProductionNotesRc(note,rc.identifier,context),'SummaryDocuments');
          if(proof.digest!==rc.digest||proof.fingerprint!==manifest.fingerprint||(await this.xsd.validate(summary,'SummaryDocuments')).xmlSha256!==rc.xml.sha256)throw Error('Firma/XSD RC inconsistente');
        }else if(manifest.fileName!==prefix+'.zip')throw Error('Nombre individual inconsistente');
        return {xml,zip};
    }
    protected async adapter(row: ProductionNotesDispatch) {
        const ruc = row.payload.payload.snapshot.issuer.identityNumber, { credentials: c } = await this.policy.current(ruc, row.payload.payload.admission), aad = { ruc, environment: 'PRODUCTION' };
        if (!c.solUsernameCipher || !c.solPasswordCipher)
            throw Error('SOL pendiente');
        const user = this.vault.open(c.solUsernameCipher, { ...aad, field: 'solUsername' });
        let password: Buffer | undefined;
        try {
            password = this.vault.open(c.solPasswordCipher, { ...aad, field: 'solPassword' });
            const auth = createProductionSoapAuthorization({ ruc, operations: productionNotesUsesRc(row.payload.payload.snapshot) ? ['sendSummary','getStatus'] : ['sendBill'] }, async () => { await this.authorize(row); });
            return new BoundedSoapAdapter({ environment: 'PRODUCTION', ruc, solUser: user.toString(), solPassword: password.toString() }, auth);
        }
        finally {
            user.fill(0);
            password?.fill(0);
        }
    }
    private async completeRc(row:ProductionNotesDispatch,manifest:ProductionNotesManifest,zip:Buffer){
      if(!manifest.rc)throw Error('Manifiesto RC requerido');
      await this.archived(row,manifest);
      const note=row.payload.payload.snapshot,name='R-'+manifest.fileName.replace(/\.zip$/,'.xml');
      const parsed=parseCdrZip(zip,{fileName:name,issuerRuc:note.issuer.identityNumber,reference:manifest.rc.identifier});
      const checked=await this.evidence.cdr(zip,parsed.xml,note.issuer.identityNumber,'RC',manifest.rc.identifier);
      await this.repository.finish(row,checked.status,{code:checked.code,trusted:true,cdrXml:await this.store.put(row.documentId,name,parsed.xml),cdrZip:await this.store.put(row.documentId,'R-'+manifest.fileName,zip)});
    }
    private async poll(id:string){
      const row=await this.repository.claimPoll(id);if(!row)return;
      try{
        await this.authorize(row);if(!row.manifest?.rc)throw Error('RC no preparado');
        await this.archived(row,row.manifest);
        const result=await (await this.adapter(row)).getStatus(row.ticket);
        if(result.kind==='CDR')await this.completeRc(row,row.manifest,result.cdrZip);
        else await this.repository.deferPoll(row,result.kind==='PROCESSING'?'PROCESSING':result.code);
      }catch{await this.repository.deferPoll(row,'GETSTATUS_RECONCILIATION_REQUIRED');}
    }
    async process(id: string) {
        const initial = await this.repository.load(id);
        if(initial?.phase==='POLLING')return this.poll(id);
        if (!initial || !['AWAITING_AUTHORIZATION', 'PREPARED'].includes(initial.phase))
            return;
        await this.authorize(initial);
        const row = await this.repository.claim(id);
        if (!row)
            return;
        let posted = false;
        try {
            const manifest = row.manifest ?? await this.prepare(row);
            await this.repository.prepared(row, manifest);
            const archived = await this.archived(row, manifest);
            await this.authorize(row);
            const adapter = await this.adapter(row);
            await this.repository.sending(row);
            posted = true;
            if(manifest.rc){
              const ticket=await adapter.submitSummary({documentId:id,fileName:manifest.fileName,zip:archived.zip,sha256:manifest.zip.sha256});
              await this.repository.ticket(row,ticket);
              return;
            }
            const result = await adapter.submit({ documentId: id, fileName: manifest.fileName, zip: archived.zip, sha256: manifest.zip.sha256 });
            if (result.kind !== 'CDR')
                throw Error('Nota productiva requiere CDR directo');
            // Re-read physical request bytes and canonical snapshot before interpreting the CDR.
            await this.archived(row, manifest);
            const name = 'R-' + manifest.fileName.replace(/\.zip$/, '.xml');
            const parsed = parseCdrZip(result.cdrZip, { fileName: name, issuerRuc: row.payload.payload.snapshot.issuer.identityNumber, reference: row.payload.payload.snapshot.fullNumber });
            const checked = await this.evidence.cdr(result.cdrZip, parsed.xml, row.payload.payload.snapshot.issuer.identityNumber, row.payload.payload.snapshot.documentTypeCode, row.payload.payload.snapshot.fullNumber);
            await this.repository.finish(row, checked.status, { code: checked.code, trusted: true, cdrXml: await this.store.put(id, name, parsed.xml), cdrZip: await this.store.put(id, 'R-' + manifest.fileName, result.cdrZip) });
        }
        catch (error) {
            const business = error instanceof SoapSubmissionError && error.kind === 'BUSINESS';
            await this.repository.finish(row, posted && !business ? 'UNKNOWN' : 'BLOCKED', { code: posted ? 'RECONCILIATION_REQUIRED' : 'LOCAL_PREFLIGHT_FAILED' });
        }
    }
}
