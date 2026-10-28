import {describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {parseReceivedXml} from '../packages/received-core/src/index';
import {receivedXml} from './received-fixture.mjs';
import {
  receivedArtifacts,receivedDate,receivedDetail,receivedExact,receivedFile,receivedManifest,receivedPage,
  receivedProjection,receivedRow,receivedScope,receivedScopeQuery,receivedSelection,
  type ReceivedArtifactView,
} from '../packages/service-access/src/b2b-received-wire';

const id=(n:number)=>`fea80000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const scope={environment:'BETA' as const,companyId:1,recipientRuc:'00000000101',branchId:id(1)};
const selection={scope,from:'2026-01-01',to:'2026-01-02',limit:2};
function fixture(type='01'){
  const agent=type==='20'?'Retention':type==='40'?'Perception':null;
  const xml=agent?`<${agent} xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:${agent}-1" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1"><cbc:ID>RQA1-1</cbc:ID><cbc:IssueDate>2026-01-01</cbc:IssueDate><cac:AgentParty><cac:PartyIdentification><cbc:ID schemeID="6">00000000303</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>AGENTE FICTICIO</cbc:RegistrationName></cac:PartyLegalEntity></cac:AgentParty><cac:ReceiverParty><cac:PartyIdentification><cbc:ID schemeID="6">00000000101</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cbc:TotalInvoiceAmount currencyID="PEN">3.00</cbc:TotalInvoiceAmount><sac:SUNAT${agent}DocumentReference><cbc:ID schemeID="01">FQA1-1</cbc:ID><cbc:TotalInvoiceAmount currencyID="PEN">100.00</cbc:TotalInvoiceAmount></sac:SUNAT${agent}DocumentReference></${agent}>`:receivedXml(type);
  const bytes=Buffer.from(xml),p=parseReceivedXml(bytes);
  const row={id:id(5),companyId:1,recipientRuc:scope.recipientRuc,branchId:scope.branchId,
    supplierRuc:p.supplier.identityNumber!,supplierName:p.supplier.legalName,documentType:p.documentType,
    fullNumber:p.fullNumber,issueDate:p.issueDate,currencyCode:p.currencyCode,payableAmount:p.totals.payableAmount,
    receivedAt:'2026-10-23T12:00:00.000Z',itemCount:p.items.length,sunatStatus:'NOT_CHECKED' as const,
    lastVerifiedAt:null,registeredAt:null,erpReference:null,warnings:p.warnings};
  const artifact:ReceivedArtifactView={id:id(6),kind:'XML',fileName:'Factura José (original).xml',mediaType:'application/xml',
    sha256:sha(bytes),byteLength:bytes.length,representation:'PROVIDER_ORIGINAL',signatureTrust:'NOT_VERIFIED'};
  const detail={schemaVersion:'factuez.b2b.received-detail.v1' as const,scope:{...scope},document:row,projection:p,artifacts:[artifact],
    fiscalAcceptance:'NOT_VERIFIED' as const,source:'RECEIVED_XML' as const};
  const page={schemaVersion:'factuez.b2b.received-page.v1',scope:{...scope},items:[row],page:{limit:2,hasMore:false,nextAfter:null,consistency:'LIVE_KEYSET_NOT_SNAPSHOT'},
    fiscalAcceptance:'NOT_VERIFIED',source:'RECEIVED_XML'};
  const manifest={schemaVersion:'factuez.b2b.received-artifacts.v1',scope:{...scope},documentId:row.id,items:[artifact],fiscalAcceptance:'NOT_VERIFIED'};
  return {bytes,p,row,artifact,detail,page,manifest};
}
function rejected(work:()=>unknown,status=503,code='INVALID_RECEIVED_OWNER_RESPONSE'){
  try{work();throw new Error('EXPECTED_REJECTION');}catch(error){expect(error).toMatchObject({status,code});}
}
function put(v:any,path:string,value:unknown){const keys=path.split('.'),last=keys.pop()!;for(const key of keys)v=v[key];v[last]=value;}

describe('B2B08 received wire: exact parser grammar and preserved original evidence',()=>{
  it.each(['01','03','07','08','09','31','20','40'])('accepts the real generated %s XML projection unchanged',type=>{
    const f=fixture(type);expect(receivedProjection(f.p)).toEqual(f.p);
    expect(receivedDetail(f.detail,scope,f.row.id)).toEqual(f.detail);
  });
  it('preserves signed, high precision and non-18 tax strings; never recalculates or normalizes',()=>{
    const xml=receivedXml().replaceAll('<cbc:Percent>18','<cbc:Percent>7.50')
      .replace('5.000','+00005.00000000000000000000');
    const p=parseReceivedXml(Buffer.from(xml));
    expect(receivedProjection(p)).toEqual(p);expect(p.items[0].quantity).toBe('+00005.00000000000000000000');
    expect(p.items[0].taxes[0].percent).toBe('7.50');expect(p.items[0].unitValue).toBe('20.000000');
    const q=structuredClone(p);q.items[0].quantity='-0000.000';q.items[0].unitPrice='9'.repeat(30)+'.'+'9'.repeat(20);
    expect(receivedProjection(q)).toEqual(q);
  });
  it('retains nullable optional parser fields and an absent item description as empty string, not invented metadata',()=>{
    const f=fixture(),p=f.p;
    p.currencyCode=null;p.issueTime=null;p.dueDate=null;p.supplier={identityNumber:null,identityType:null,legalName:null,address:null};
    p.items[0].description='';for(const k of ['quantity','unitCode','unitValue','unitPrice','lineExtensionAmount']) (p.items[0] as any)[k]=null;
    expect(receivedProjection(p)).toEqual(p);
  });
  it('returns detached frozen projections without mutating input',()=>{
    const f=fixture(),p=receivedProjection(f.p);f.p.items[0].description='changed';
    expect(p.items[0].description).not.toBe('changed');expect(Object.isFrozen(p.items[0])).toBe(true);
  });
  it.each(['schemaVersion','documentType','fullNumber','series','number','issueDate','xmlSha256','items.0.lineId','items.0.description'])
    ('required projection %s cannot be null',path=>{const p:any=fixture().p;put(p,path,null);rejected(()=>receivedProjection(p));});
  it.each([
    ['documentType','NV'],['fullNumber','F001-0'],['fullNumber','F001-000'],['fullNumber','F001-1-x'],
    ['fullNumber','F001-1234567890123'],['series','OTHER'],['number','00000000000000'],
    ['issueDate','2026-02-29'],['issueTime','25:00:00'],['issueTime','12:60:00'],['issueTime','12:00:00+15:00'],
    ['dueDate','2026-02-30'],['currencyCode','pen'],['xmlSha256','a'.repeat(63)],['supplier.identityNumber','123'],
    ['signature.status','VALID'],['signature.officialTrust',true],['references', [{kind:null,number:null,documentType:null}]],
    ['paymentTerms',[{id:null,means:null,amount:'1',dueDate:'2026-04-31'}]],
    ['items.0.allowances',[{charge:'true',amount:'1',reason:null}]],['items.0.lineId','  '],
    ['notes',[null]],['warnings',[null]],['supplier.legalName','bad\u0000name'],['recipient.address','bad\ud800'],
  ])('rejects malformed projection %s = %j',(path,value)=>{const p:any=fixture().p;put(p,path,value);rejected(()=>receivedProjection(p));});
  const decimals=['totals.payableAmount','totals.prepaidAmount','taxes.0.amount','taxes.0.percent','items.0.quantity',
    'items.0.unitValue','items.0.unitPrice','items.0.lineExtensionAmount','items.0.taxes.0.taxableAmount'];
  for(const path of decimals)it.each([1,NaN,Infinity,'NaN','Infinity','1e3',' 1','1 ','1.','0x10','.1','1,00','9'.repeat(31),'1.'+'9'.repeat(21)])
    (`rejects invalid decimal ${path} = %j`,value=>{const p:any=fixture().p;put(p,path,value);rejected(()=>receivedProjection(p));});
  it('rejects duplicate item IDs, missing keys and fiscal flags at every projected layer',()=>{
    const f=fixture();f.p.items.push(structuredClone(f.p.items[0]));rejected(()=>receivedProjection(f.p));
    for(const path of ['', 'supplier','recipient','totals','signature','items.0','items.0.taxes.0']){
      const p:any=fixture().p;let v=p;for(const k of path.split('.').filter(Boolean))v=v[k];v.acceptedBySunat=true;
      rejected(()=>receivedProjection(p));delete v.acceptedBySunat;delete v[Object.keys(v)[0]];rejected(()=>receivedProjection(p));
    }
  });
});

describe('hostile object graphs never run code and all owner errors are finite',()=>{
  it.each(['proxy','revoked','getter','hidden','symbol','prototype','cycle','hole','array-extra','deep','large'])('rejects %s',kind=>{
    let p:any=fixture().p;const trap=vi.fn(()=>{throw new Error('PRIVATE_SECRET');});
    if(kind==='proxy')p.items[0]=new Proxy(p.items[0],{get:trap,ownKeys:trap,getPrototypeOf:trap});
    if(kind==='revoked'){const r=Proxy.revocable(p,{});p=r.proxy;r.revoke();}
    if(kind==='getter')Object.defineProperty(p.supplier,'legalName',{get:trap,enumerable:true});
    if(kind==='hidden')Object.defineProperty(p.totals,'secret',{value:'hidden'});
    if(kind==='symbol')p.supplier[Symbol('secret')]='hidden';
    if(kind==='prototype')Object.setPrototypeOf(p.supplier,{secret:'hidden'});
    if(kind==='cycle')p.notes.push(p);
    if(kind==='hole')delete p.items[0];
    if(kind==='array-extra')p.items.extra='hidden';
    if(kind==='deep'){let a:any={};p.notes=[a];for(let i=0;i<40;i++)a=a.next={};}
    if(kind==='large')p.notes=['x'.repeat(2*1024*1024+1)];
    rejected(()=>receivedProjection(p));expect(trap).not.toHaveBeenCalled();
  });
  it('validates receivedExact deeply without invoking a getter or sorting caller keys',()=>{
    const keys=['b','a'],get=vi.fn();receivedExact({a:1,b:2},keys);expect(keys).toEqual(['b','a']);
    const input={a:1,b:{}};Object.defineProperty(input.b,'x',{enumerable:true,get});
    rejected(()=>receivedExact(input,keys),400,'INVALID_RECEIVED_REQUEST');expect(get).not.toHaveBeenCalled();
  });
  it.each([null,[],true,'wrong',new Date(),{unknown:true}].map(value=>({value})))('malformed envelope $value has no TypeError or evidence error',({value})=>{
    rejected(()=>receivedDetail(value,scope,id(5)));rejected(()=>receivedPage(value,selection));
    rejected(()=>receivedManifest(value,scope,id(5)));if(!Array.isArray(value))rejected(()=>receivedArtifacts(value));rejected(()=>receivedRow(value,scope));
  });
});

describe('rows, instants, recipient context and bounded live keysets',()=>{
  it.each(['receivedAt','documentType','fullNumber','issueDate','id','itemCount','warnings'])('requires row %s',key=>{
    const r:any=fixture().row;r[key]=null;rejected(()=>receivedRow(r,scope));
  });
  it.each(['not-a-date','2026-02-30T12:00:00Z','2026-01-01','2026-01-01T12:00:00','2026-01-01T24:00:00Z',
    '2026-01-01T12:60:00Z','2026-01-01T12:00:00+14:01','2026-01-01T12:00:00+15:00'])('rejects invalid instant %s',value=>{
    const r=fixture().row;r.receivedAt=value;rejected(()=>receivedRow(r,scope));
    r.receivedAt='2026-01-01T12:00:00Z';r.registeredAt=value as any;rejected(()=>receivedRow(r,scope));
  });
  it.each(['2026-01-01T12:00:00Z','2026-01-01T12:00:00.123456789-05:00','2026-01-01T12:00:00+14:00'])('preserves valid instant %s',value=>{
    const r=fixture().row;r.receivedAt=value;expect(receivedRow(r,scope).receivedAt).toBe(value);
  });
  it.each([{companyId:2},{branchId:id(90)},{recipientRuc:'00000000909'},{branchId:null},{sunatStatus:'ACCEPTED'},
    {lastVerifiedAt:'2026-01-01T12:00:00Z'},{documentType:'NV'},{itemCount:1001},{itemCount:1.2},{payableAmount:118}])
    ('rejects row context/metadata %j',patch=>rejected(()=>receivedRow({...fixture().row,...patch},scope)));
  it.each([
    ['scope.recipientRuc','00000000909'],['document.id',id(9)],['document.supplierName','stale'],['document.warnings',[]],
    ['projection.supplier.identityNumber','00000000909'],['projection.recipient.identityType','1'],
    ['projection.series','OTHER'],['document.itemCount',2],['document.payableAmount','118.000'],
    ['artifacts.0.sha256','a'.repeat(64)],['fiscalAcceptance','ACCEPTED'],['source','SIRE_TOTALS'],
  ])('blocks stale or substituted detail %s',(path,value)=>{const f:any=fixture(),requested=f.row.id;put(f.detail,path,value);rejected(()=>receivedDetail(f.detail,scope,requested));});
  it('requires one and only one provider original XML',()=>{
    const f=fixture();f.detail.artifacts.push({...f.artifact,id:id(7),sha256:'b'.repeat(64)});
    rejected(()=>receivedDetail(f.detail,scope,f.row.id));
  });
  it('accepts empty and final pages plus a full bounded hasMore page',()=>{
    const f=fixture();expect(receivedPage(f.page,selection).items).toHaveLength(1);
    f.page.items=[];expect(receivedPage(f.page,selection).items).toEqual([]);
    f.page.items=[f.row,{...f.row,id:id(8)}];f.page.page.hasMore=true;f.page.page.nextAfter=id(8) as any;
    expect(receivedPage(f.page,selection).page.nextAfter).toBe(id(8));
  });
  it.each(['cross-scope','order','duplicate','after','before-date','after-date','type','limit','overflow','empty-more','short-more','cursor','final-cursor','snapshot'])
    ('rejects invalid page %s',kind=>{
      const f=fixture(),p:any=f.page,q:any={...selection};
      if(kind==='cross-scope')p.scope={...scope,companyId:2};
      if(kind==='order')p.items=[{...f.row,id:id(8)},f.row];
      if(kind==='duplicate')p.items=[f.row,f.row];
      if(kind==='after')q.after=f.row.id;
      if(kind==='before-date')p.items[0].issueDate='2025-12-31';
      if(kind==='after-date')p.items[0].issueDate='2026-01-03';
      if(kind==='type')q.type='03';
      if(kind==='limit')p.page.limit=1;
      if(kind==='overflow')p.items=[f.row,{...f.row,id:id(7)},{...f.row,id:id(8)}];
      if(kind==='empty-more'){p.items=[];p.page.hasMore=true;p.page.nextAfter=id(5);}
      if(kind==='short-more'){p.page.hasMore=true;p.page.nextAfter=id(5);}
      if(kind==='cursor'){p.items=[f.row,{...f.row,id:id(8)}];p.page.hasMore=true;p.page.nextAfter=id(7);}
      if(kind==='final-cursor')p.page.nextAfter=id(5);
      if(kind==='snapshot')p.page.consistency='SNAPSHOT';
      rejected(()=>receivedPage(p,q));
    });
  it.each([{limit:0},{limit:101},{limit:Infinity},{limit:2.2},{limit:'2'},{from:'2026-02-30'},
    {from:'2026-01-02',to:'2026-01-01'},{from:'2024-01-01'},{after:null},{after:undefined},{type:null},{type:'NV'},{extra:true}])
    ('rejects invalid query %j',patch=>rejected(()=>receivedSelection({...selection,...patch}),400,'INVALID_RECEIVED_REQUEST'));
  it('retains QA00 RUCs and validates scope without RUC checksums',()=>{
    expect(receivedScope(scope)).toEqual(scope);expect(receivedScopeQuery({...scope,companyId:'1'})).toEqual(scope);
    expect(receivedDate('2024-02-29')).toBe(true);expect(receivedDate('2026-02-29')).toBe(false);
    rejected(()=>receivedScope({...scope,environment:'PRODUCTION'}),400,'INVALID_RECEIVED_REQUEST');
  });
});

describe('original file metadata, Unicode HTTP filenames and exact bytes',()=>{
  it.each(['Factura José (compra).xml','Factura..versión.xml',"XML d’Ángel's.xml",'发票 🧾.XML'])('retains safe Unicode filename %s',fileName=>{
    const a={...fixture().artifact,fileName};expect(receivedArtifacts([a])[0].fileName).toBe(fileName);expect(()=>encodeURIComponent(fileName)).not.toThrow();
  });
  it.each(['../original.xml','C:original.xml','C:\\original.xml','sub/original.xml','evil\r\nHeader.xml','bad\u0085.xml','\ud800.xml',
    'bad\u202e.xml','bad\u2028.xml','original.xml\n','original','original.pdf','original.zip'])('rejects unsafe XML filename %j',fileName=>{
    rejected(()=>receivedArtifacts([{...fixture().artifact,fileName}]));
  });
  it.each([
    ['XML','application/xml','original.xml'],['CDR','application/xml','R-original.XML'],['CDR','application/zip','R-original.zip'],
    ['PROVIDER_PDF','application/pdf','Factura José.pdf'],
  ])('accepts consistent kind/MIME/extension %s %s %s',(kind,mediaType,fileName)=>{
    expect(receivedArtifacts([{...fixture().artifact,kind,mediaType,fileName}])).toHaveLength(1);
  });
  it.each([{kind:'CDR',fileName:'R-original.pdf',mediaType:'application/pdf'},
    {kind:'PROVIDER_PDF',fileName:'original.xml',mediaType:'application/xml'},
    {mediaType:'text/xml'},{mediaType:'application/pdf'},{signatureTrust:'TRUSTED'},{representation:'GENERATED'},
    {byteLength:0},{byteLength:10*1024*1024+1},{byteLength:1.5},{sha256:'A'.repeat(64)},{id:null}])
    ('rejects invalid metadata %j',patch=>rejected(()=>receivedArtifacts([{...fixture().artifact,...patch}])));
  it('rejects duplicate IDs and oversized manifests',()=>{
    const a=fixture().artifact;rejected(()=>receivedArtifacts([a,a]));rejected(()=>receivedArtifacts(Array.from({length:21},(_,i)=>({...a,id:id(i+1)}))));
  });
  it('binds manifests to the exact requested document and recipient',()=>{
    const f=fixture();expect(receivedManifest(f.manifest,scope,f.row.id).items).toHaveLength(1);
    rejected(()=>receivedManifest(f.manifest,scope,id(99)));
    rejected(()=>receivedManifest({...f.manifest,scope:{...scope,recipientRuc:'00000000909'}},scope,f.row.id));
    rejected(()=>receivedManifest({...f.manifest,fiscalAcceptance:'ACCEPTED'},scope,f.row.id));
  });
  it('copies exact verified originals without sharing the returned Buffer',()=>{
    const f=fixture(),file={bytes:f.bytes,sha256:f.artifact.sha256,fileName:f.artifact.fileName,mediaType:f.artifact.mediaType};
    const v=receivedFile(file,f.artifact);expect(v.bytes).toEqual(f.bytes);expect(v.bytes).not.toBe(f.bytes);
    f.bytes[0]=0;expect(v.bytes[0]).not.toBe(0);
  });
  it.each(['hash','filename','mime','length','extra','getter','proxy','buffer-proxy','forged-buffer','buffer-prototype-proxy','buffer-getter'])('rejects or safely bypasses binary trap %s',kind=>{
    const f=fixture();let file:any={bytes:f.bytes,sha256:f.artifact.sha256,fileName:f.artifact.fileName,mediaType:f.artifact.mediaType};
    const trap=vi.fn(()=>{throw new Error('PRIVATE_SECRET');});
    if(kind==='hash')file.bytes=Buffer.alloc(f.bytes.length);
    if(kind==='filename')file.fileName='other.xml';
    if(kind==='mime')file.mediaType='application/pdf';
    if(kind==='length')file.bytes=Buffer.alloc(1);
    if(kind==='extra')file.secret='PRIVATE_SECRET';
    if(kind==='getter')Object.defineProperty(file,'bytes',{enumerable:true,get:trap});
    if(kind==='proxy')file=new Proxy(file,{get:trap,ownKeys:trap,getPrototypeOf:trap});
    if(kind==='buffer-proxy')file.bytes=new Proxy(file.bytes,{get:trap,getPrototypeOf:trap});
    if(kind==='forged-buffer')file.bytes=Object.create(Buffer.prototype);
    if(kind==='buffer-prototype-proxy')Object.setPrototypeOf(file.bytes,new Proxy(Buffer.prototype,{get:trap,getPrototypeOf:trap}));
    if(kind==='buffer-getter'){
      Object.defineProperty(file.bytes,'length',{get:trap});Object.defineProperty(file.bytes,'copy',{get:trap});
      expect(receivedFile(file,f.artifact).bytes).toEqual(fixture().bytes);
    }else rejected(()=>receivedFile(file,f.artifact),409,'RECEIVED_INTEGRITY_FAILED');
    expect(trap).not.toHaveBeenCalled();
  });
});
