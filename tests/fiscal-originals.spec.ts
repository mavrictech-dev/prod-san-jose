import 'reflect-metadata';
import {createHash,randomUUID} from 'node:crypto';
import {zipSync} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {buildInvoiceUbl, buildReceiptSummary, buildReceiptSummarySnapshot, calculateDocumentTotals, fiscalSnapshotSha256, limaIssueDate} from '../packages/sunat-core/src';
import {FiscalOriginalsService} from '../services/sunat-service/src/application/fiscal-originals.service';
const ruc='20615878481',id=randomUUID(),auth='Bearer SYNTHETIC',number='F001-1';
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const inv=(issuer=ruc,reference=number)=>Buffer.from(`<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cbc:ID>${reference}</cbc:ID><cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode><cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>${issuer}</cbc:ID></cac:PartyIdentification></cac:Party></cac:AccountingSupplierParty></Invoice>`);
const cdr=(issuer=ruc,reference=number)=>Buffer.from(`<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${issuer}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:DocumentReference><cbc:ID>${reference}</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`);
// Structural originals only. These synthetic files assert no trusted signature or SUNAT acceptance.
function fixture(kind='xml'){
 const snapshot={documentId:id,companyId:1,environment:'PRODUCTION',documentTypeCode:'01',issuer:{identityNumber:ruc},series:'F001',number:'1',fullNumber:number};
 const own:any={documentId:id,environment:'PRODUCTION',issuerRuc:ruc,documentType:'01',series:'F001',number:1n,immutablePayload:JSON.parse(JSON.stringify(snapshot))};
 const xml=inv(),base=`${ruc}-01-${number}`;
 const bytes=kind==='xml'?xml:kind==='cdr-xml'?cdr():Buffer.from(zipSync({[`${kind==='cdr-zip'?'R-':''}${base}.xml`]:kind==='cdr-zip'?cdr():xml}));
 const artifact:any={documentId:id,kind:({'xml':'SIGNED_XML','cdr-xml':'CDR_XML','cdr-zip':'CDR_ZIP','submission-zip':'SUBMISSION_ZIP'} as any)[kind],storageKey:'SYNTHETIC',mediaType:kind.endsWith('zip')?'application/zip':'application/xml',sizeBytes:BigInt(bytes.length),sha256:digest(bytes)};
 const state:any={snapshot,own,artifact,bytes,xml};
 const fetch=vi.fn(async()=>Response.json({id,immutableSnapshot:state.snapshot}));vi.stubGlobal('fetch',fetch);
 const prisma={fiscalDocument:{findUnique:vi.fn(async()=>state.own)},documentArtifact:{findUnique:vi.fn(async({where}:any)=>where.documentId_kind.kind==='SIGNED_XML'&&kind==='submission-zip'?{documentId:id,sha256:digest(state.xml)}:state.artifact)}};
 const store={read:vi.fn(async()=>state.bytes),put:vi.fn()};
 const service=new FiscalOriginalsService(prisma as never,store as never);
 return{state,fetch,prisma,store,service,run:()=>service.download(id,kind,auth),replace:(b:Buffer)=>{state.bytes=b;artifact.sha256=digest(b);artifact.sizeBytes=BigInt(b.length);}};
}
afterEach(()=>vi.unstubAllGlobals());
describe('Authorized original downloads do not generate or assert fiscal acceptance',()=>{
 it.each(['xml','cdr-xml','cdr-zip','submission-zip'])('returns exact stored %s bytes only after checking Billing',async kind=>{
  const f=fixture(kind),result=await f.run();expect(result.bytes).toEqual(f.state.bytes);expect(result.mediaType).toBe(f.state.artifact.mediaType);expect(f.fetch).toHaveBeenCalledOnce();expect(f.store.put).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('accepted');expect(result).not.toHaveProperty('signatureVerified');
 });
 it.each([['bad','xml',auth],[id,'../../xml',auth],[id,'xml',undefined],[id,'xml','Basic bad']])('rejects invalid caller or route %# before data access',async(doc,kind,token)=>{
  const f=fixture();await expect(f.service.download(doc!,kind!,token)).rejects.toBeDefined();expect(f.fetch).not.toHaveBeenCalled();expect(f.store.read).not.toHaveBeenCalled();
 });
 it.each([401,403,404,503])('does not read private data if Billing responds %i',async status=>{
  const f=fixture();f.fetch.mockResolvedValueOnce(new Response('{}',{status}));await expect(f.run()).rejects.toBeDefined();expect(f.prisma.fiscalDocument.findUnique).not.toHaveBeenCalled();expect(f.store.read).not.toHaveBeenCalled();
 });
 it('checks permission again on the next download rather than using cached authorization',async()=>{
  const f=fixture();await f.run();f.fetch.mockResolvedValueOnce(new Response('{}',{status:401}));await expect(f.run()).rejects.toMatchObject({status:401});expect(f.store.read).toHaveBeenCalledOnce();
 });
 it.each(['BETA','03','other-owner','other-snapshot'])('rejects mismatched document context %s',async change=>{
  const f=fixture();if(change==='BETA')f.state.snapshot.environment='BETA';else if(change==='03')f.state.snapshot.documentTypeCode='03';else if(change==='other-owner')f.state.own.issuerRuc='20123456789';else f.state.own.immutablePayload.fullNumber='F001-2';
  await expect(f.run()).rejects.toMatchObject({status:409});expect(f.store.read).not.toHaveBeenCalled();
 });
 it.each(['documentId','kind','mediaType','sha256','sizeBytes'])('rejects invalid original metadata %s before reading bytes',async key=>{
  const f=fixture();f.state.artifact[key]=key==='sizeBytes'?0n:'WRONG';await expect(f.run()).rejects.toMatchObject({status:409});expect(f.store.read).not.toHaveBeenCalled();
 });
 it('reports a pending CDR without inventing it',async()=>{
  const f=fixture('cdr-xml');f.state.artifact=null;await expect(f.run()).rejects.toThrow('todavía no disponible');expect(f.store.read).not.toHaveBeenCalled();expect(f.store.put).not.toHaveBeenCalled();
 });
 it('rejects bytes whose hash or length differs from the stored record',async()=>{
  const f=fixture();f.state.bytes=Buffer.from('CHANGED');await expect(f.run()).rejects.toMatchObject({status:409});
 });
 it.each([inv('20123456789'),inv(ruc,'F001-2'),Buffer.from('<!DOCTYPE Invoice SYSTEM "file:///etc/passwd"><Invoice/>')])('rejects a foreign or unsafe XML despite matching storage hash %#',async bytes=>{
  const f=fixture();f.replace(bytes);await expect(f.run()).rejects.toMatchObject({status:409});
 });
 it.each([cdr('20123456789'),cdr(ruc,'F001-2')])('rejects a CDR linked to another document/RUC %#',async bytes=>{
  const f=fixture('cdr-xml');f.replace(bytes);await expect(f.run()).rejects.toMatchObject({status:409});
 });
 it('matches the exact signed XML hash inside the submission ZIP',async()=>{
  const f=fixture('submission-zip');f.state.xml=Buffer.from('another signed XML');await expect(f.run()).rejects.toMatchObject({status:409});
 });
});

function receiptFixture(kind:string){
 const snapshot:any={documentId:randomUUID(),companyId:1,environment:'PRODUCTION',documentTypeCode:'03',series:'B001',number:'1',fullNumber:'B001-1',
  issueDate:new Date().toISOString(),currencyCode:'PEN',operationTypeCode:'0101',paymentTerms:{type:'CONTADO'},
  issuer:{identityType:'6',identityNumber:'20100070970',legalName:'FICTITIOUS LOCAL',address:'LOCAL TEST',ubigeo:'150101',establishmentCode:'0000'},
  customer:{identityType:'0',identityNumber:'0',legalName:'FICTITIOUS LOCAL'},
  ...calculateDocumentTotals([{description:'LOCAL TEST',quantity:'1',unitCode:'NIU',unitPriceWithTax:'1.18',igvRate:'18',taxAffectationCode:'10'}])};
 const reference='RC-'+limaIssueDate(snapshot.issueDate).replaceAll('-','')+'-1',expected=buildReceiptSummarySnapshot(snapshot,reference),batchId=randomUUID();
 const member=Buffer.from(buildInvoiceUbl(snapshot,{mode:'REAL_PREPARATION'})),rc=Buffer.from(buildReceiptSummary(snapshot,reference,'REAL_PREPARATION'));
 const response=cdr(snapshot.issuer.identityNumber,reference),base=snapshot.issuer.identityNumber+'-'+reference;
 const data=new Map<string,Buffer>(),docArtifacts:any[]=[],batchArtifacts:any[]=[];
 function artifact(owner:string,k:string,bytes:Buffer,batch=false){const a:any={[batch?'batchId':'documentId']:owner,kind:k,storageKey:randomUUID(),sha256:digest(bytes),sizeBytes:BigInt(bytes.length),mediaType:k.endsWith('ZIP')?'application/zip':'application/xml'};data.set(a.storageKey,bytes);(batch?batchArtifacts:docArtifacts).push(a);return a;}
 const documentXml=artifact(snapshot.documentId,'SIGNED_XML',member),individualXmlZip=artifact(snapshot.documentId,'SUBMISSION_ZIP',Buffer.from(zipSync({[snapshot.issuer.identityNumber+'-03-B001-1.xml']:member})));
 const xml=artifact(batchId,'SIGNED_XML',rc,true),zip=artifact(batchId,'SUBMISSION_ZIP',Buffer.from(zipSync({[base+'.xml']:rc})),true);
 for(const k of ['CDR_XML','CDR_ZIP']){const bytes=k==='CDR_XML'?response:Buffer.from(zipSync({['R-'+base+'.xml']:response}));artifact(snapshot.documentId,k,bytes);artifact(batchId,k,bytes,true);}
 const stored=(a:any)=>({storageKey:a.storageKey,sha256:a.sha256,sizeBytes:Number(a.sizeBytes)}),eventId=randomUUID();
 const manifest:any={reference,requestOwnerId:expected.documentId,documentSnapshotSha256:fiscalSnapshotSha256(snapshot),documentXml:stored(documentXml),individualXmlZip:stored(individualXmlZip),xml:stored(xml),zip:stored(zip)};
 const batch:any={id:batchId,environment:'PRODUCTION',issuerRuc:snapshot.issuer.identityNumber,summaryId:snapshot.documentId,identifier:reference,billingEventId:eventId,immutablePayload:expected};
 const submission:any={batch,errorMessage:JSON.stringify({version:1,eventId,prepared:manifest})};
 const own={documentId:snapshot.documentId,environment:'PRODUCTION',issuerRuc:snapshot.issuer.identityNumber,documentType:'03',series:'B001',number:1n,immutablePayload:JSON.parse(JSON.stringify(snapshot))};
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:snapshot.documentId,immutableSnapshot:snapshot})));
 const prisma:any={fiscalDocument:{findUnique:vi.fn(async()=>own)},sunatSubmission:{findMany:vi.fn(async()=>[submission])},batchArtifact:{findMany:vi.fn(async()=>batchArtifacts)},documentArtifact:{findUnique:vi.fn(async({where}:any)=>docArtifacts.find(a=>a.kind===where.documentId_kind.kind))}};
 const store={read:vi.fn(async(owner:string,a:any)=>{const isBatch=batchArtifacts.some(x=>x.storageKey===a.storageKey);if(owner!==(isBatch?expected.documentId:snapshot.documentId))throw Error('WRONG_OWNER');return data.get(a.storageKey)!;}),put:vi.fn()};
 const service=new FiscalOriginalsService(prisma,store as never);
 return{run:()=>service.download(snapshot.documentId,kind,auth),snapshot,reference,batch,submission,manifest,docArtifacts,batchArtifacts,data,zip,member,rc,store};
}
describe('original boleta03 and exact original RC files',()=>{
 it.each(['xml','cdr-xml','cdr-zip','submission-zip'])('returns exact %s and identifies the RC when applicable',async kind=>{
  const f=receiptFixture(kind),result=await f.run();expect(result.fileName).toContain(kind==='xml'?'03-B001-1':f.reference);expect(f.store.put).not.toHaveBeenCalled();
  if(kind==='xml')expect(result.bytes).toEqual(f.member);
  if(kind==='submission-zip')expect(result.bytes).toEqual(f.data.get(f.zip.storageKey));
 });
 it.each(['batch-owner','member','snapshot','CDR-hash','document-zip'])('refuses foreign or replaced RC evidence %s',async change=>{
  const f=receiptFixture(change==='document-zip'?'submission-zip':'cdr-xml');
  if(change==='batch-owner')f.batch.issuerRuc='20123456789';
  if(change==='member')f.batch.immutablePayload.input.entries[0].document.snapshot.fullNumber='B001-2';
  if(change==='snapshot'){f.manifest.documentSnapshotSha256='a'.repeat(64);f.submission.errorMessage=JSON.stringify({version:1,eventId:f.batch.billingEventId,prepared:f.manifest});}
  if(change==='CDR-hash')f.batchArtifacts.find(a=>a.kind==='CDR_XML').sha256='b'.repeat(64);
  if(change==='document-zip')f.data.set(f.zip.storageKey,f.data.get(f.docArtifacts.find(a=>a.kind==='SUBMISSION_ZIP').storageKey)!);
  await expect(f.run()).rejects.toMatchObject({status:409});
 });
 it('retrieves a stable historical RC after its original emission window without changing authority or PKI',async()=>{
  const f=receiptFixture('submission-zip');vi.useFakeTimers();vi.setSystemTime(Date.now()+31*86400000);
  try{expect((await f.run()).bytes).toEqual(f.data.get(f.zip.storageKey));}finally{vi.useRealTimers();}
 });
});
