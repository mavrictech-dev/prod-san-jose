import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import type {ImapFlow} from 'imapflow';

const forbidden=vi.hoisted(()=>({imap:vi.fn(function(){throw new Error('REAL_IMAP_FORBIDDEN');})}));
vi.mock('../services/received-documents-service/node_modules/imapflow',()=>({ImapFlow:forbidden.imap}));
vi.mock('@factuez/received-core',async()=>import('../packages/received-core/src/index'));

import {B2bReceptionReadOnlySource,type B2bReceptionReadOnlySourceOptions} from '../services/received-documents-service/src/b2b/automation-read-only.source';
import type {ReadOnlyReceptionSnapshot} from '../services/received-documents-service/src/b2b/automation-read-only.types';
import {createReceptionAutomationVault} from '../services/received-documents-service/src/b2b/automation';
import {mailAttachments,mailboxFingerprint,mailboxOptions,visitMailbox,MAX_MAIL_BYTES} from '../services/received-documents-service/src/automation/mailbox';
import {fixtureMail} from '../services/received-documents-service/src/automation/mail-fixture';
import {fixtureSirePurchases} from '../services/received-documents-service/src/automation/sire-fixture';
import {SIRE_RCE_HEADERS} from '../services/received-documents-service/src/automation/sire-parser';
import {assertSireReadRequest} from '../services/received-documents-service/src/automation/sire-http';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';

// Every identity, host, credential, MIME message, token and archive is fictitious.
// Both real transports are tripwires; these tests never use sockets or real QA.
const ruc='00000000001',supplier='00000000002',period='202610',host='imap.qa.example.com';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const credentials={mailPassword:'FAKE-MAIL',sireClientSecret:'FAKE-SIRE',solPassword:'FAKE-SOL'};
const vault=createReceptionAutomationVault(new Uint8Array(32).fill(41));
const aad={companyId:101,ruc,revision:3};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function snapshot(source:'MAIL'|'SIRE'='MAIL'):ReadOnlyReceptionSnapshot{
 const settings={enabled:true,mode:'LIVE_READ_ONLY' as const,intervalMinutes:15,
  mailbox:{enabled:true,host,port:993 as const,folder:'INBOX',username:'FAKE-USER'},
  sire:{enabled:true,startPeriod:period,clientId:'fixture-client',solUsername:'FAKEUSER'}};
 const context={runId:uuid(1),scope:{environment:'BETA' as const,companyId:101,recipientRuc:ruc,branchId:uuid(2)},
  source,revision:3,actor:{kind:'SERVICE' as const,clientId:uuid(3),subjectId:null,clientRevision:2,userAuthRevision:null}};
 const encryptedCredentials=vault.seal(credentials,aad) as string;
 const configurationSha256=hash({scope:context.scope,revision:context.revision,settings});
 return {context,settings,configurationSha256,encryptedCredentials,periods:[period],cursor:null,
  admission:{approvalId:uuid(4),revision:1,profile:'READ_ONLY',contextSha256:hash(context),configurationSha256,approvedImapHosts:[host]}};
}
function rebind(s:ReadOnlyReceptionSnapshot){
 s.admission.contextSha256=hash(s.context);
 s.configurationSha256=hash({scope:s.context.scope,revision:s.context.revision,settings:s.settings});
 s.admission.configurationSha256=s.configurationSha256;return s;
}
type File={fileName:string;bytes:Buffer};
async function xml(number=period):Promise<File>{
 const [file]=await mailAttachments(fixtureMail(ruc,period));
 return {fileName:`${supplier}-01-FZ01-${number}.xml`,bytes:Buffer.from(file.bytes.toString().replace(`FZ01-${period}`,`FZ01-${number}`))};
}
function cdr(number=period,recipient=ruc):File{
 return {fileName:`R-${supplier}-01-FZ01-${number}.xml`,bytes:Buffer.from(
  `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cac:DocumentResponse><cac:DocumentReference><cbc:ID>FZ01-${number}</cbc:ID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:DocumentReference><cac:IssuerParty><cac:PartyIdentification><cbc:ID schemeID="6">${supplier}</cbc:ID></cac:PartyIdentification></cac:IssuerParty><cac:RecipientParty><cac:PartyIdentification><cbc:ID schemeID="6">${recipient}</cbc:ID></cac:PartyIdentification></cac:RecipientParty></cac:DocumentResponse></ApplicationResponse>`)};
}
function mime(files:File[]):Buffer{
 return Buffer.from('From: fictitious@example.invalid\r\nTo: fictitious@example.invalid\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="FAKE"\r\n\r\n'+
  files.map(file=>`--FAKE\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${file.fileName}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${file.bytes.toString('base64')}\r\n`).join('')+'--FAKE--\r\n');
}
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}return (crc^0xffffffff)>>>0;}
function zip(files:File[]):Buffer{
 const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const file of files){
  const name=Buffer.from(file.fileName),local=Buffer.alloc(30),directory=Buffer.alloc(46),crc=crc32(file.bytes);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);
  local.writeUInt32LE(file.bytes.length,18);local.writeUInt32LE(file.bytes.length,22);local.writeUInt16LE(name.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);
  directory.writeUInt32LE(crc,16);directory.writeUInt32LE(file.bytes.length,20);directory.writeUInt32LE(file.bytes.length,24);
  directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
  locals.push(local,name,file.bytes);central.push(directory,name);offset+=local.length+name.length+file.bytes.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);
 end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
type Message={uid:number;raw:Buffer;size?:number};
function fakeImap(messages:Message[]=[],options:{uidValidity?:bigint;uidNext?:number;events?:string[]}={}){
 const event=(name:string)=>options.events?.push(name);
 const fake={
  on:vi.fn(),close:vi.fn(()=>event('close')),
  connect:vi.fn(async()=>{event('connect');}),
  getMailboxLock:vi.fn(async()=>{event('examine');return {release:vi.fn()};}),
  mailbox:{uidValidity:options.uidValidity??7n,uidNext:options.uidNext??Math.max(1,...messages.map(m=>m.uid+1))},
  fetchAll:vi.fn(async(range:string)=>{event('metadata');const [start,end]=range.split(':').map(Number);
   return messages.filter(m=>m.uid>=start&&m.uid<=end).map(m=>({uid:m.uid,size:m.size??m.raw.length}));}),
  download:vi.fn(async(uid:string)=>{event('download');const message=messages.find(m=>String(m.uid)===uid)!;
   return {content:Readable.from([Buffer.from(message.raw)])};}),
  messageFlagsAdd:vi.fn(()=>{throw new Error('MARK_SEEN_FORBIDDEN');}),
  mailboxCreate:vi.fn(()=>{throw new Error('WRITE_FORBIDDEN');}),
 };
 const factory=vi.fn((_options:ReturnType<typeof mailboxOptions>)=>fake as unknown as ImapFlow);
 return {fake,factory};
}
function runMail(messages:Message[],s=snapshot(),options:B2bReceptionReadOnlySourceOptions={},check=vi.fn(async()=>{})){
 const imap=fakeImap(messages);
 return {...imap,check,source:new B2bReceptionReadOnlySource(vault,{imapFactory:imap.factory,...options}),snapshot:s};
}
function sireText(count=1,rejected=0,p=period):Buffer{
 const raw=fixtureSirePurchases(ruc,p)[0].rawRecord;
 const rows=Array.from({length:count+rejected},(_,i)=>SIRE_RCE_HEADERS.map((header,j)=>
  j===9?String(i+1):j===11&&i>=count?'1':j===12&&i>=count?'12345678':raw[header]??'').join('|')+'|');
 return Buffer.from(SIRE_RCE_HEADERS.join('|')+'|\n'+rows.join('\n')+'\n');
}
function sireFetch(bytes=zip([{fileName:'proposal.txt',bytes:sireText()}]),p=period){
 const ticket='20260100000001';
 const replies=[()=>Response.json({access_token:'FAKE-TOKEN',token_type:'bearer'}),()=>Response.json({numTicket:ticket}),
  ()=>Response.json({registros:[{perTributario:p,numTicket:ticket,codProceso:'10',codEstadoProceso:'06',detalleTicket:{numTicket:ticket},
   archivoReporte:[{nomArchivoReporte:'FAKE-proposal.zip',codTipoAchivoReporte:'01'}]}]}),()=>new Response(new Uint8Array(bytes))];
 const fetcher=vi.fn<typeof fetch>(async(address,init)=>{
  assertSireReadRequest(String(address),init?.method??'GET');const next=replies.shift();if(!next)throw new Error('UNEXPECTED_FAKE_FETCH');return next();
 });return fetcher;
}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('REAL_HTTP_FORBIDDEN');}));});
afterEach(()=>{expect(forbidden.imap).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('B2B reception source admission and vault',()=>{
 it('accepts an independently admitted USER with userAuthRevision zero',async()=>{
  const s=snapshot();s.context.actor={kind:'USER',clientId:uuid(3),subjectId:uuid(5),clientRevision:2,userAuthRevision:0};rebind(s);
  const f=runMail([],s);const batch=await f.source.read(s,f.check);
  expect(batch.cursor).toMatchObject({uidValidity:'7',lastUid:'0'});expect(f.fake.connect).toHaveBeenCalledOnce();
 });
 it.each([-1,0.5,null,2147483648])('rejects invalid USER userAuthRevision %s before vault',async userAuthRevision=>{
  const s=snapshot();s.context.actor={kind:'USER',clientId:uuid(3),subjectId:uuid(5),clientRevision:2,userAuthRevision};rebind(s);
  const open=vi.fn();await expect(new B2bReceptionReadOnlySource({open}).read(s,async()=>{}))
   .rejects.toMatchObject({status:403,code:'RECEIVED_READ_ONLY_APPROVAL_REQUIRED'});expect(open).not.toHaveBeenCalled();
 });
 it('performs no I/O on construction and rejects absent independently supplied admission',async()=>{
  const open=vi.fn(),fetcher=vi.fn(),imapFactory=vi.fn();const source=new B2bReceptionReadOnlySource({open},{fetch:fetcher,imapFactory});
  expect(open).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(imapFactory).not.toHaveBeenCalled();
  await expect(source.read({...snapshot(),admission:undefined} as unknown as ReadOnlyReceptionSnapshot,async()=>{})).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(imapFactory).not.toHaveBeenCalled();
 });
 it.each(['profile','context','configuration','config-drift','hosts','duplicates','mode','environment','source','revision','actor','cursor','settings','cipher','periods','extra'])(
  'rejects invalid %s before vault/transport',async kind=>{
   const s=snapshot();
   if(kind==='profile')(s.admission as any).profile='LIVE_READ_ONLY';
   if(kind==='context')s.context.runId=uuid(99);
   if(kind==='configuration')s.admission.configurationSha256='f'.repeat(64);
   if(kind==='config-drift')s.settings.mailbox.folder='ANOTHER-FAKE-FOLDER';
   if(kind==='hosts')s.admission.approvedImapHosts=['localhost'];
   if(kind==='duplicates')s.admission.approvedImapHosts=[host,host];
   if(kind==='mode')s.settings.mode='LOCAL_FIXTURE';
   if(kind==='environment')(s.context.scope as any).environment='PRODUCTION';
   if(kind==='source')(s.context as any).source='ALL';
   if(kind==='revision'){s.context.revision=0;rebind(s);}
   if(kind==='actor'){s.context.actor.subjectId=uuid(5);rebind(s);}
   if(kind==='cursor')s.cursor={fingerprint:'f'.repeat(64),uidValidity:'7',lastUid:'1'};
   if(kind==='settings')s.settings.mailbox.enabled=false;
   if(kind==='cipher')s.encryptedCredentials='not-an-envelope';
   if(kind==='periods')s.periods=['../url'];
   if(kind==='extra')(s as any).networkEnabled=true;
   const open=vi.fn(),factory=vi.fn();const source=new B2bReceptionReadOnlySource({open},{imapFactory:factory});
   await expect(source.read(s,async()=>{})).rejects.toThrow();expect(open).not.toHaveBeenCalled();expect(factory).not.toHaveBeenCalled();
  });
 it('inspects accessors without executing them',async()=>{
  const getter=vi.fn();const s=snapshot();Object.defineProperty(s,'context',{get:getter,enumerable:true});
  await expect(new B2bReceptionReadOnlySource(vault).read(s,async()=>{})).rejects.toThrow();expect(getter).not.toHaveBeenCalled();
 });
 it('checks before opening vault and binds company/RUC/revision AAD',async()=>{
  const events:string[]=[],s=snapshot(),open=vi.fn(async(cipher,context)=>{events.push('vault');return vault.open(cipher,context);});
  const imap=fakeImap([]),check=vi.fn(async()=>{events.push('check');});
  await new B2bReceptionReadOnlySource({open},{imapFactory:imap.factory}).read(s,check);
  expect(events.slice(0,3)).toEqual(['check','vault','check']);expect(open).toHaveBeenCalledWith(s.encryptedCredentials,aad);
  const foreign=rebind({...s,context:{...s.context,scope:{...s.context.scope,companyId:202}}});
  await expect(new B2bReceptionReadOnlySource(vault,{imapFactory:imap.factory}).read(foreign,async()=>{})).rejects.toThrow('RECEIVED_VAULT_UNAVAILABLE');
 });
 it('revocation before vault opens no secrets or transports',async()=>{
  const open=vi.fn(),factory=vi.fn();
  await expect(new B2bReceptionReadOnlySource({open},{imapFactory:factory}).read(snapshot(),async()=>{throw new B2bSecurityError(403,'REVOKED');})).rejects.toThrow('REVOKED');
  expect(open).not.toHaveBeenCalled();expect(factory).not.toHaveBeenCalled();
 });
 it.each(['MAIL','SIRE'] as const)('missing %s credentials yields sanitized B2B 403 before transport',async source=>{
  const factory=vi.fn(),fetcher=vi.fn();
  await expect(new B2bReceptionReadOnlySource({open:()=>({})},{imapFactory:factory,fetch:fetcher}).read(snapshot(source),async()=>{}))
   .rejects.toMatchObject({status:403,code:'RECEIVED_READ_ONLY_APPROVAL_REQUIRED'});
  expect(factory).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
 });
 it('vault failures yield B2B 503 without the private original error',async()=>{
  await expect(new B2bReceptionReadOnlySource({open:()=>{throw new Error('FAKE-PRIVATE-VAULT-DETAIL');}}).read(snapshot(),async()=>{}))
   .rejects.toMatchObject({status:503,code:'RECEIVED_VAULT_UNAVAILABLE',message:'RECEIVED_VAULT_UNAVAILABLE'});
 });
 it.each([0,11,1.5,NaN])('rejects source maxMessages %s without I/O',maxMessages=>{
  expect(()=>new B2bReceptionReadOnlySource(vault,{maxMessages})).toThrow('RECEIVED_READ_ONLY_NOT_CONFIGURED');
 });
});

describe('READ ONLY IMAP originals and cursor',()=>{
 it('returns original XML/CDR/PDF including ZIP and normalized numeric filename association',async()=>{
  const document=await xml('000001'),response=cdr('1'),pdf={fileName:`${supplier}-01-FZ01-01.pdf`,bytes:Buffer.from('%PDF-FAKE ORIGINAL')};
  const raw=mime([{fileName:'originals.zip',bytes:zip([document,response,pdf])}]),f=runMail([{uid:8,raw}]);
  const batch=await f.source.read(f.snapshot,f.check);
  expect(batch.documents).toEqual([{file:{fileName:document.fileName,contentBase64:document.bytes.toString('base64')},artifacts:[
   {kind:'CDR',file:{fileName:response.fileName,contentBase64:response.bytes.toString('base64')}},
   {kind:'PROVIDER_PDF',file:{fileName:pdf.fileName,contentBase64:pdf.bytes.toString('base64')}}]}]);
  expect(batch).toMatchObject({purchases:[],incidents:[],cursor:{fingerprint:mailboxFingerprint(f.snapshot.settings.mailbox),uidValidity:'7',lastUid:'8'}});
  expect(f.fake.getMailboxLock).toHaveBeenCalledWith('INBOX',{readOnly:true});
  expect(f.fake.download).toHaveBeenCalledWith('8',undefined,{uid:true,maxBytes:MAX_MAIL_BYTES});
  expect(f.fake.messageFlagsAdd).not.toHaveBeenCalled();expect(f.fake.mailboxCreate).not.toHaveBeenCalled();
 });
 it('guards each IMAP remote operation before and after and before consuming a message',async()=>{
  const events:string[]=[],check=vi.fn(async()=>{events.push('check');});
  const imap=fakeImap([{uid:1,raw:fixtureMail(ruc,period)}],{events});
  await new B2bReceptionReadOnlySource(vault,{imapFactory:imap.factory}).read(snapshot(),check);
  for(const name of ['connect','examine','metadata','download']){const i=events.indexOf(name);expect(events[i-1]).toBe('check');expect(events[i+1]).toBe('check');}
  const i=events.indexOf('download');expect(events.slice(i+1,i+3)).toEqual(['check','check']);
 });
 it.each(['connect','examine','metadata','download'])('revocation after %s prevents further network/consumption',async stop=>{
  const events:string[]=[],imap=fakeImap([{uid:1,raw:fixtureMail(ruc,period)}],{events});
  const check=vi.fn(async()=>{if(events.includes(stop))throw new Error('REVOKED');});
  await expect(new B2bReceptionReadOnlySource(vault,{imapFactory:imap.factory}).read(snapshot(),check)).rejects.toThrow();
  expect(events.filter(e=>e!=='close')).toEqual(['connect','examine','metadata','download'].slice(0,['connect','examine','metadata','download'].indexOf(stop)+1));
  expect(imap.fake.close).toHaveBeenCalled();
 });
 it('defaults to five messages and permits an explicit bounded limit',async()=>{
  const raw=fixtureMail(ruc,period),messages=Array.from({length:12},(_,i)=>({uid:i+1,raw}));
  for(const limit of [undefined,1,10]){
   const f=runMail(messages,snapshot(),{maxMessages:limit});const batch=await f.source.read(f.snapshot,f.check);
   expect(batch.documents).toHaveLength(limit??5);expect(batch.cursor?.lastUid).toBe(String(limit??5));expect(f.fake.download).toHaveBeenCalledTimes(limit??5);
  }
 });
 it('uses checkpoint UIDVALIDITY, resets safely on rebuild and scans UID gaps',async()=>{
  for(const validity of ['7','6']){
   const s=snapshot();s.cursor={fingerprint:mailboxFingerprint(s.settings.mailbox),uidValidity:validity,lastUid:'8'};
   const f=runMail([{uid:3,raw:fixtureMail(ruc,period)},{uid:9,raw:fixtureMail(ruc,period)}],s);
   const batch=await f.source.read(s,f.check);expect(batch.documents).toHaveLength(validity==='7'?1:2);
   expect(batch.cursor).toEqual({...s.cursor,uidValidity:'7',lastUid:'9'});
  }
 });
 it.each(['0','18446744073709551616','NaN'])('rejects invalid UIDVALIDITY %s before vault',async uidValidity=>{
  const s=snapshot();s.cursor={fingerprint:mailboxFingerprint(s.settings.mailbox),uidValidity,lastUid:'1'};
  const open=vi.fn();await expect(new B2bReceptionReadOnlySource({open}).read(s,async()=>{})).rejects.toThrow();expect(open).not.toHaveBeenCalled();
 });
 it('quarantines oversized/raw-null metadata and returns proposed cursor without downloading or marking Seen',async()=>{
  const f=runMail([{uid:1,raw:Buffer.from('FAKE'),size:MAX_MAIL_BYTES+1},{uid:2,raw:Buffer.from('FAKE'),size:0}]);
  const batch=await f.source.read(f.snapshot,f.check);
  expect(batch.documents).toEqual([]);expect(batch.incidents.map(i=>i.code)).toEqual(['DOCUMENT_TOO_LARGE','DOCUMENT_TOO_LARGE']);
  expect(batch.incidents.every(i=>/^[a-f0-9]{64}$/.test(i.sourceSha256))).toBe(true);expect(batch.cursor?.lastUid).toBe('2');expect(f.fake.download).not.toHaveBeenCalled();
 });
 it('quarantines malformed MIME, missing XML and foreign recipient with metadata hashes only',async()=>{
  const invalidXml={fileName:'invalid.xml',bytes:Buffer.from('<Invoice>FAKE')};
  const f=runMail([{uid:1,raw:Buffer.from('FAKE non-MIME')},{uid:2,raw:mime([invalidXml])},{uid:3,raw:fixtureMail('00000000999',period)}]);
  const batch=await f.source.read(f.snapshot,f.check);
  expect(batch.documents).toHaveLength(0);expect(batch.incidents.map(i=>i.code)).toEqual(['INVALID_MESSAGE','INVALID_DOCUMENT','INVALID_DOCUMENT']);
  expect(batch.cursor?.lastUid).toBe('3');for(const incident of batch.incidents)expect(Object.keys(incident).sort()).toEqual(['code','sourceSha256']);
  expect(JSON.stringify(batch)).not.toContain('<Invoice>');expect(JSON.stringify(batch)).not.toContain('invalid.xml');
 });
 it('does not associate mismatched supplier/type/series/number, suffix names, or invalid CDR contents',async()=>{
  const document=await xml('1'),badCdr=cdr('1','00000000999');
  const pdfs=[`${supplier}-01-FZ01-2.pdf`,'00000000999-01-FZ01-1.pdf',`${supplier}-03-FZ01-1.pdf`,`${supplier}-01-FZ02-1.pdf`,`${supplier}-01-FZ01-1-copy.pdf`]
   .map(fileName=>({fileName,bytes:Buffer.from('%PDF-FAKE')}));
  const f=runMail([{uid:1,raw:mime([document,badCdr,...pdfs])}]);const batch=await f.source.read(f.snapshot,f.check);
  expect(batch.documents[0].artifacts).toEqual([]);expect(batch.incidents.map(i=>i.code)).toEqual(['INVALID_DOCUMENT',...pdfs.map(()=>'ARTIFACT_UNMATCHED')]);
 });
 it('does not attach ambiguous related files to duplicate document identities',async()=>{
  const document=await xml('1'),pdf={fileName:`${supplier}-01-FZ01-1.pdf`,bytes:Buffer.from('%PDF-FAKE')};
  const f=runMail([{uid:1,raw:mime([document,{...document,fileName:'duplicate.xml'},pdf])}]);const batch=await f.source.read(f.snapshot,f.check);
  expect(batch.documents).toHaveLength(2);expect(batch.documents.every(d=>!d.artifacts.length)).toBe(true);expect(batch.incidents[0].code).toBe('ARTIFACT_UNMATCHED');
 });
 it('quarantines per-file payloads above 64 KiB, including archive entries, without replacing bytes',async()=>{
  const document=await xml(),large={...document,bytes:Buffer.concat([document.bytes,Buffer.alloc(65537-document.bytes.length,32)])};
  const f=runMail([{uid:1,raw:mime([large])},{uid:2,raw:mime([{fileName:'oversize.zip',bytes:zip([large])}])}]);
  const batch=await f.source.read(f.snapshot,f.check);expect(batch.documents).toEqual([]);
  expect(batch.incidents.map(i=>i.code)).toEqual(['DOCUMENT_TOO_LARGE','DOCUMENT_TOO_LARGE']);expect(batch.cursor?.lastUid).toBe('2');
 });
 it('accepts exact 64 KiB originals and PDFs without changing the import payload',async()=>{
  const document=await xml(),padded={...document,bytes:Buffer.concat([document.bytes,Buffer.alloc(65536-document.bytes.length,32)])};
  const pdf={fileName:`${supplier}-01-FZ01-${period}.pdf`,bytes:Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(65531,32)])};
  const f=runMail([{uid:1,raw:mime([padded,pdf])}]);const batch=await f.source.read(f.snapshot,f.check);
  expect(batch.incidents).toEqual([]);expect(Buffer.from(batch.documents[0].file.contentBase64,'base64').equals(padded.bytes)).toBe(true);
  expect(Buffer.from(batch.documents[0].artifacts[0].file.contentBase64,'base64').equals(pdf.bytes)).toBe(true);
 });
 it('fails instead of returning a partial batch/cursor above 50 documents',async()=>{
  const files=await Promise.all(Array.from({length:51},(_,i)=>xml(String(i+1))));
  const f=runMail([{uid:1,raw:mime([{fileName:'many.zip',bytes:zip(files)}])}]);
  await expect(f.source.read(f.snapshot,f.check)).rejects.toThrow('NARROW_QUERY');expect(f.fake.messageFlagsAdd).not.toHaveBeenCalled();
 });
 it('fails instead of returning a partial batch/cursor above 100 incidents',async()=>{
  const files=await Promise.all(Array.from({length:100},async(_,i)=>{const file=await xml(String(i+1));return {...file,bytes:Buffer.from(file.bytes.toString().replace(ruc,'00000000999'))};}));
  const raw=mime([{fileName:'many-rejected.zip',bytes:zip(files)}]);const f=runMail([{uid:1,raw},{uid:2,raw}]);
  await expect(f.source.read(f.snapshot,f.check)).rejects.toThrow('NARROW_QUERY');expect(f.fake.download).toHaveBeenCalledTimes(2);
 });
 it('fails above 5 MiB serialized JSON including base64 artifact overhead',async()=>{
  const files=(await Promise.all(Array.from({length:31},async(_,i)=>{
   const file=await xml(String(i+1));return [{...file,bytes:Buffer.concat([file.bytes,Buffer.alloc(65536-file.bytes.length,32)])},
    {fileName:`${supplier}-01-FZ01-${i+1}.pdf`,bytes:Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(65531,32)])}];
  }))).flat();
  const raw=mime([{fileName:'large-originals.zip',bytes:zip(files)}]);const f=runMail([{uid:1,raw}]);
  await expect(f.source.read(f.snapshot,f.check)).rejects.toThrow('NARROW_QUERY');expect(f.fake.messageFlagsAdd).not.toHaveBeenCalled();
 });
});

describe('READ ONLY SIRE using only injected fetch fixtures',()=>{
 it('reads only existing OAuth POST/export/consult/download GET and returns discoveries without manufacturing XML',async()=>{
  const fetcher=sireFetch(),events:string[]=[],check=vi.fn(async()=>{events.push('check');});
  const wrapped:typeof fetch=async(...args)=>{events.push('http');return fetcher(...args);};
  const batch=await new B2bReceptionReadOnlySource(vault,{fetch:wrapped}).read(snapshot('SIRE'),check);
  expect(batch.documents).toEqual([]);expect(batch.incidents).toEqual([]);expect(batch.cursor).toBeNull();expect(batch.purchases).toHaveLength(1);
  expect(batch.purchases[0]).toMatchObject({recipientRuc:ruc,period,supplierRuc:supplier,number:'1',amount:'118.00'});
  expect(fetcher.mock.calls.map(([,init])=>init?.method)).toEqual(['POST','GET','GET','GET']);
  for(let i=0;i<events.length;i++)if(events[i]==='http'){expect(events[i-1]).toBe('check');expect(events[i+1]).toBe('check');}
  for(const [url,init]of fetcher.mock.calls){expect(()=>assertSireReadRequest(String(url),init?.method??'GET')).not.toThrow();expect(init?.redirect).toBe('manual');}
 });
 it('preserves parser incidents as bounded metadata SHA-256, with no rejected rawRecord in output',async()=>{
  const fetcher=sireFetch(zip([{fileName:'proposal.txt',bytes:sireText(1,1)}]));
  const batch=await new B2bReceptionReadOnlySource(vault,{fetch:fetcher}).read(snapshot('SIRE'),async()=>{});
  expect(batch.purchases).toHaveLength(1);expect(batch.incidents).toEqual([{code:'SIRE_RECORD_REJECTED',sourceSha256:expect.stringMatching(/^[a-f0-9]{64}$/)}]);
  expect(JSON.stringify(batch.incidents)).not.toContain('12345678');expect(batch.documents).toEqual([]);
 });
 it('accepts 100 records and fails NARROW above that, counting rejected records too',async()=>{
  for(const [accepted,rejected]of [[100,0],[101,0],[100,1]]){
   const fetcher=sireFetch(zip([{fileName:'proposal.txt',bytes:sireText(accepted,rejected)}]));
   const read=new B2bReceptionReadOnlySource(vault,{fetch:fetcher}).read(snapshot('SIRE'),async()=>{});
   if(accepted+rejected>100)await expect(read).rejects.toThrow('NARROW_QUERY');else expect((await read).purchases).toHaveLength(100);
  }
 });
 it('keeps the supplied three queued periods and enforces 100 records across the run',async()=>{
  for(const counts of [[34,33,33],[34,34,33]]){
   const s=snapshot('SIRE'),periods=['202608','202609','202610'];s.periods=periods;s.settings.sire.startPeriod=periods[0];rebind(s);
   const fetchers=periods.map((p,i)=>sireFetch(zip([{fileName:'proposal.txt',bytes:sireText(counts[i],0,p)}]),p));let requests=0;
   const fetcher=vi.fn<typeof fetch>((...args)=>fetchers[Math.floor(requests++/4)](...args));
   const read=new B2bReceptionReadOnlySource(vault,{fetch:fetcher}).read(s,async()=>{});
   if(counts.reduce((a,b)=>a+b)>100)await expect(read).rejects.toMatchObject({code:'NARROW_QUERY'});
   else {const batch=await read;expect(batch.purchases).toHaveLength(100);expect([...new Set(batch.purchases.map(p=>p.period))]).toEqual(periods);}
   expect(fetcher).toHaveBeenCalledTimes(12);
  }
 });
 it.each([1,2,3,4])('stops when approval is revoked after HTTP request %i',async count=>{
  const fetcher=sireFetch(),check=vi.fn(async()=>{if(fetcher.mock.calls.length>=count)throw new Error('REVOKED');});
  await expect(new B2bReceptionReadOnlySource(vault,{fetch:fetcher}).read(snapshot('SIRE'),check)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(count);
 });
 it('checks after failed HTTP and does not fall back to fixtures',async()=>{
  const events:string[]=[],fetcher=vi.fn<typeof fetch>(async()=>{events.push('failed-http');throw new Error('FAKE-NETWORK-FAILURE');});
  await expect(new B2bReceptionReadOnlySource(vault,{fetch:fetcher}).read(snapshot('SIRE'),async()=>{events.push('check');})).rejects.toMatchObject({status:503,code:'RECEIVED_READ_ONLY_SOURCE_UNAVAILABLE'});
  const i=events.indexOf('failed-http');expect(events.slice(i-1,i+2)).toEqual(['check','failed-http','check']);expect(fetcher).toHaveBeenCalledTimes(1);
 });
});

describe('mailbox explicit allowlist and backward compatible limits',()=>{
 it('uses explicit hosts without environment mutation and retains TLS/host validation',()=>{
  const m=snapshot().settings.mailbox,before=process.env.RECEIVED_IMAP_APPROVED_HOSTS;
  const options=mailboxOptions(m,'FAKE',true,[host]);
  expect(options.tls).toEqual({rejectUnauthorized:true,minVersion:'TLSv1.2',servername:host});expect(options.secure).toBe(true);
  expect(process.env.RECEIVED_IMAP_APPROVED_HOSTS).toBe(before);
  for(const hosts of [[],['localhost'],['127.0.0.1'],[`${host},other.example.com`],Array.from({length:17},()=>host)])expect(()=>mailboxOptions(m,'FAKE',true,hosts)).toThrow();
  expect(()=>mailboxOptions(m,'FAKE',false,[host])).toThrow();
 });
 it.each([0,51,1.5,NaN])('rejects mailbox maxMessages %s before constructing client',async maxMessages=>{
  const factory=vi.fn();await expect(visitMailbox(snapshot().settings.mailbox,'FAKE',null,async()=>{},true,factory,[host],{maxMessages})).rejects.toThrow('MAILBOX_BATCH_INVALID');expect(factory).not.toHaveBeenCalled();
 });
 it('keeps the legacy default of 50 messages',async()=>{
  const raw=Buffer.from('FAKE'),imap=fakeImap(Array.from({length:52},(_,i)=>({uid:i+1,raw}))),consume=vi.fn(async()=>{});
  const cursor=await visitMailbox(snapshot().settings.mailbox,'FAKE',null,consume,true,imap.factory,[host]);
  expect(consume).toHaveBeenCalledTimes(50);expect(cursor.lastUid).toBe(50);
 });
 it('keeps legacy environment allowlist when no explicit list is supplied',()=>{
  const m=snapshot().settings.mailbox;
  vi.stubEnv('RECEIVED_IMAP_APPROVED_HOSTS',host);expect(mailboxOptions(m,'FAKE',true).host).toBe(host);
  vi.stubEnv('RECEIVED_IMAP_APPROVED_HOSTS','other.example.com');expect(()=>mailboxOptions(m,'FAKE',true)).toThrow();
  expect(mailboxOptions(m,'FAKE',true,[host]).host).toBe(host);vi.unstubAllEnvs();
 });
});
