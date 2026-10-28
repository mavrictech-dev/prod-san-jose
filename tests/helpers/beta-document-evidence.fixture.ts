import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {vi} from 'vitest';
import {buildInvoiceUbl} from '../../packages/sunat-core/src/ubl';
import {fiscalSnapshotSha256,buildFiscalNoteUbl,buildFiscalNoteSnapshot} from '../../packages/sunat-core/src/fiscal-note';
import {verifyBetaDocumentAcceptance,type BetaAcceptedDocumentRecord,type BetaDocumentAcceptancePorts} from '../../services/sunat-service/src/application/beta-document-acceptance';
import {supplementCommandFixture,supplementUuid as id} from './fiscal-supplement.fixture';
const local=createRequire(new URL('../../services/sunat-service/package.json',import.meta.url));
export const {zipSync}=local('fflate') as typeof import('../../services/sunat-service/node_modules/fflate');
export const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const AS_OF='2026-10-04T18:00:00.000Z',ACCEPTED='2026-10-03T18:00:00.000Z';
export function cdrXml(fullNumber:string,type:string,ruc:string,observed=false){
  return `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ID>FICTICIO-NO-OFICIAL</cbc:ID><cbc:IssueDate>2026-10-03</cbc:IssueDate>${observed?'<cbc:Note>FICTICIO OBSERVADO</cbc:Note>':''}
<cac:SenderParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification></cac:SenderParty>
<cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${ruc}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty>
<cac:DocumentResponse><cac:Response><cbc:ReferenceID>${fullNumber}</cbc:ReferenceID><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>SIMULADO NO OFICIAL</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>${fullNumber}</cbc:ID><cbc:DocumentTypeCode>${type}</cbc:DocumentTypeCode></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
}
/** Structural port fixture: no cryptographic/PKI assertion. Crypto-specific tests replace both verification ports. */
export function documentEvidenceFixture(type:'01'|'07'|'08'='01',observed=false){
  const data=supplementCommandFixture(),debit=type==='08'?buildFiscalNoteSnapshot(data.context,{documentTypeCode:'08',reasonCode:'02',reasonDescription:'AUMENTO FICTICIO',lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'1'}]},
    {documentId:id(4),series:'FD01',number:'1',issueDate:'2026-10-02T17:00:00Z'}):undefined;
  const doc=structuredClone(type==='01'?data.doc:debit??data.note),noteContext=type!=='01'?data.context:undefined;
  const unsigned=type==='01'?buildInvoiceUbl(doc as typeof data.doc,{mode:'REAL_PREPARATION'}):buildFiscalNoteUbl(doc as typeof data.note,noteContext!);
  let xml=Buffer.from(unsigned),cdr=Buffer.from(cdrXml(doc.fullNumber,type,doc.issuer.identityNumber,observed));
  const pack=()=>Buffer.from(zipSync({[`R-${doc.issuer.identityNumber}-${type}-${doc.fullNumber}.xml`]:cdr}));
  let zip=pack();
  const request=()=>Buffer.from(zipSync({[`${doc.issuer.identityNumber}-${type}-${doc.fullNumber}.xml`]:xml}));let requestZip=request();
  const record:BetaAcceptedDocumentRecord={document:structuredClone(doc),...(noteContext?{noteContext:structuredClone(noteContext)}:{}),submissionId:id(50),
    completedAt:ACCEPTED,status:observed?'ACCEPTED_WITH_OBSERVATIONS':'ACCEPTED',signerFingerprint:'a'.repeat(64),digestValue:Buffer.alloc(32,1).toString('base64'),version:'b'.repeat(64),
    signedXml:{id:id(51),storageKey:`${doc.documentId}/xml.xml`,sha256:hash(xml),sizeBytes:xml.length},
    cdrZip:{id:id(52),storageKey:`${doc.documentId}/cdr.zip`,sha256:hash(zip),sizeBytes:zip.length},
    requestZip:{id:id(53),storageKey:`${doc.documentId}/request.zip`,sha256:hash(requestZip),sizeBytes:requestZip.length}};
  const ports={load:vi.fn(async()=>structuredClone(record)),read:vi.fn(async(_id:string,a:BetaAcceptedDocumentRecord['signedXml'])=>Buffer.from(a.id===record.signedXml.id?xml:a.id===record.requestZip.id?requestZip:zip)),
    verifyIssuer:vi.fn(async()=>({digestValue:record.digestValue,certificateFingerprint:record.signerFingerprint,trustStoreSha256:'c'.repeat(64),checkedAt:AS_OF})),
    verifyCdr:vi.fn(async()=>true)} satisfies BetaDocumentAcceptancePorts;
  return {doc,record,ports,unsigned,get xml(){return xml;},get zip(){return zip;},get cdr(){return cdr;},
    get requestZip(){return requestZip;},
    setRequestZip(bytes:Buffer){requestZip=Buffer.from(bytes);record.requestZip.sha256=hash(requestZip);record.requestZip.sizeBytes=requestZip.length;},
    setXml(bytes:Buffer){xml=Buffer.from(bytes);record.signedXml.sha256=hash(xml);record.signedXml.sizeBytes=xml.length;requestZip=request();record.requestZip.sha256=hash(requestZip);record.requestZip.sizeBytes=requestZip.length;},
    setCdr(bytes:Buffer){cdr=Buffer.from(bytes);zip=pack();record.cdrZip.sha256=hash(zip);record.cdrZip.sizeBytes=zip.length;},
    setZip(bytes:Buffer){zip=Buffer.from(bytes);record.cdrZip.sha256=hash(zip);record.cdrZip.sizeBytes=zip.length;},
    run:()=>verifyBetaDocumentAcceptance(doc,AS_OF,ports),snapshotHash:()=>fiscalSnapshotSha256(doc)};
}
