import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {ImapFlow} from 'imapflow';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScope,receivedFail} from '@factuez/service-access/dist/b2b-received-wire';
import {unpackReceivedFiles,validateReceivedCdr,type ReceivedFile} from '@factuez/received-core';
import {SireReadClient} from '../automation/sire-client';
import {assertSireReadRequest} from '../automation/sire-http';
import {prepareMailDocuments,type PreparedMail} from '../automation/importer';
import {mailAttachments,mailboxFingerprint,mailboxOptions,visitMailbox,type MailMessage} from '../automation/mailbox';
import {imapHost,parseAutomationSave,validPeriod} from '../automation/policy';
import {safeArtifactName} from '../validation';
import type {ReceptionAutomationVault} from './automation';
import type {ReadOnlyReceptionSnapshot,ReadOnlyReceptionSource,ReadOnlyReceptionBatch,
 ReadOnlyReceptionIncident,ReadOnlyReceptionFile} from './automation-read-only.types';

export type B2bReceptionReadOnlySourceOptions={fetch?:typeof fetch;
 imapFactory?:(options:ReturnType<typeof mailboxOptions>)=>ImapFlow;maxMessages?:number};
const FILE_BYTES=65536,BATCH_BYTES=5*1024*1024;
const integer=(v:unknown,min=1,max=2147483647)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const denied=():never=>receivedFail(403,'RECEIVED_READ_ONLY_APPROVAL_REQUIRED');
function exact(value:unknown,keys:readonly string[]):void{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))denied();
}
function limits(batch:ReadOnlyReceptionBatch):void{
 if(batch.documents.length>50||batch.documents.some(document=>document.artifacts.length>20)||batch.incidents.length>100||batch.purchases.length>100||
  Buffer.byteLength(JSON.stringify(batch),'utf8')>BATCH_BYTES)receivedFail(413,'NARROW_QUERY');
}
function importName(name:string):void{
 safeArtifactName(name);
 if(/[\x80-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(name)||
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name))throw new Error('INVALID_DOCUMENT_NAME');
}
function wire(file:ReceivedFile):ReadOnlyReceptionFile{return {fileName:file.fileName,contentBase64:file.bytes.toString('base64')};}
function matches(file:ReceivedFile,document:PreparedMail['documents'][number]):boolean{
 const name=file.kind==='CDR'?/^R-(\d{11})-(\d{2})-([A-Z0-9]{4})-(\d{1,8})\.xml$/i:
  /^(\d{11})-(\d{2})-([A-Z0-9]{4})-(\d{1,8})\.pdf$/i;
 const match=name.exec(file.fileName),p=document.projection;
 return !!match&&match[1]===p.supplier.identityNumber&&match[2]===p.documentType&&
  match[3].toUpperCase()===p.series&&BigInt(match[4])===BigInt(p.number);
}

/** Explicit owner-side source. Construction/import performs no I/O. The
 * admission is supplied independently by the owner executor, never inferred
 * from environment, saved configuration, or the presence of a test transport.
 * This class returns originals and metadata; only the owner commits a cursor. */
export class B2bReceptionReadOnlySource implements ReadOnlyReceptionSource{
 #vault:Pick<ReceptionAutomationVault,'open'>;
 #fetch:typeof fetch|undefined;
 #imapFactory:B2bReceptionReadOnlySourceOptions['imapFactory'];
 #maxMessages:number;
 constructor(vault:Pick<ReceptionAutomationVault,'open'>,options:B2bReceptionReadOnlySourceOptions={}){
  if(typeof vault?.open!=='function'||options.fetch!==undefined&&typeof options.fetch!=='function'||
   options.imapFactory!==undefined&&typeof options.imapFactory!=='function'||
   options.maxMessages!==undefined&&!integer(options.maxMessages,1,10))receivedFail(503,'RECEIVED_READ_ONLY_NOT_CONFIGURED');
  this.#vault=vault;this.#fetch=options.fetch;this.#imapFactory=options.imapFactory;this.#maxMessages=options.maxMessages??5;
 }
 async read(input:ReadOnlyReceptionSnapshot,check:()=>Promise<void>):Promise<ReadOnlyReceptionBatch>{
  // Inspect/detach before reading properties; an async caller cannot replace
  // configuration, approval, cursor or scope while a request is in flight.
  let snapshot:ReadOnlyReceptionSnapshot;
  try{snapshot=correctionEvidenceFreeze(input);}catch{denied();}
  exact(snapshot!,['context','configurationSha256','settings','encryptedCredentials','periods','admission','cursor']);
  const s=snapshot!,c=s.context,a=s.admission;
  exact(c,['runId','scope','source','revision','actor']);
  exact(c.actor,['kind','clientId','subjectId','clientRevision','userAuthRevision']);
  receivedScope(c.scope);
  if(!b2bUuid(c.runId)||!integer(c.revision)||!['MAIL','SIRE'].includes(c.source)||!b2bUuid(c.actor.clientId)||
   !integer(c.actor.clientRevision)||!['USER','SERVICE'].includes(c.actor.kind)||
   (c.actor.kind==='SERVICE'?(c.actor.subjectId!==null||c.actor.userAuthRevision!==null):
    (!b2bUuid(c.actor.subjectId)||!integer(c.actor.userAuthRevision,0)))||typeof check!=='function')denied();
  exact(a,['approvalId','revision','profile','contextSha256','configurationSha256','approvedImapHosts']);
  if(!b2bUuid(a.approvalId)||!integer(a.revision)||a.profile!=='READ_ONLY'||a.contextSha256!==hash(c)||
   typeof s.configurationSha256!=='string'||!/^[a-f0-9]{64}$/.test(s.configurationSha256)||a.configurationSha256!==s.configurationSha256||
   s.configurationSha256!==hash({scope:c.scope,revision:c.revision,settings:s.settings})||
   !Array.isArray(a.approvedImapHosts)||a.approvedImapHosts.length>16||new Set(a.approvedImapHosts).size!==a.approvedImapHosts.length||
   a.approvedImapHosts.some(h=>!imapHost(h)))denied();
  // The owner computes the configuration SHA independently and check revalidates
  // that live binding. A matching caller hash alone never grants network reads.
  try{parseAutomationSave({expectedRevision:c.revision-1,settings:s.settings},c.scope.recipientRuc);}catch{denied();}
  if(s.settings.mode!=='LIVE_READ_ONLY'||!s.settings.enabled||
   !(c.source==='MAIL'?s.settings.mailbox.enabled:s.settings.sire.enabled)||
   c.source==='MAIL'&&!a.approvedImapHosts.includes(s.settings.mailbox.host)||
   s.encryptedCredentials!==null&&(typeof s.encryptedCredentials!=='string'||!s.encryptedCredentials.startsWith('v1.')||s.encryptedCredentials.length>11500)||
   !Array.isArray(s.periods)||s.periods.length>3||new Set(s.periods).size!==s.periods.length||s.periods.some(p=>!validPeriod(p)||p<s.settings.sire.startPeriod)||
   c.source==='SIRE'&&!s.periods.length)denied();
  const fingerprint=mailboxFingerprint(s.settings.mailbox);
  if(s.cursor!==null){
   exact(s.cursor,['fingerprint','uidValidity','lastUid']);
   if(s.cursor.fingerprint!==fingerprint||typeof s.cursor.uidValidity!=='string'||!/^\d{1,20}$/.test(s.cursor.uidValidity)||
    BigInt(s.cursor.uidValidity)<1n||BigInt(s.cursor.uidValidity)>18446744073709551615n||
    typeof s.cursor.lastUid!=='string'||!/^\d{1,10}$/.test(s.cursor.lastUid)||BigInt(s.cursor.lastUid)>4294967295n)denied();
  }
  // Legacy transport helpers sanitize foreign errors. Preserve owner fence and
  // batch-limit failures so they cannot become a generic connection error.
  let failure:{error:unknown}|undefined;
  const guarded=async()=>{try{await check();}catch(error){
   const fault=error instanceof B2bSecurityError?error:new B2bSecurityError(503,'RECEIVED_READ_ONLY_SOURCE_UNAVAILABLE');
   failure={error:fault};throw fault;
  }};
  await guarded(); // Immediately before opening the injected vault with AAD.
  let secrets:Record<string,string>;
  try{
   const value=correctionEvidenceFreeze(await this.#vault.open(s.encryptedCredentials,
    {companyId:c.scope.companyId,ruc:c.scope.recipientRuc,revision:c.revision}));
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['mailPassword','sireClientSecret','solPassword'].includes(k))||
    Object.values(value).some(v=>typeof v!=='string'||!v.length||v.length>1024||/[\x00-\x1f\x7f]/.test(v)))throw new Error();
   secrets={...value};
  }catch{receivedFail(503,'RECEIVED_VAULT_UNAVAILABLE');}
  await guarded();
  const batch:ReadOnlyReceptionBatch={documents:[],purchases:[],incidents:[],cursor:null};
  const incident=(code:ReadOnlyReceptionIncident['code'],metadata:unknown)=>{
   batch.incidents.push({code,sourceSha256:hash({scope:c.scope,source:c.source,metadata})});limits(batch);
  };
  try{
   if(c.source==='SIRE'){
    if(!secrets.sireClientSecret||!secrets.solPassword)denied();
    const fetcher=this.#fetch??globalThis.fetch;
    const checkedFetch:typeof fetch=async(address,init)=>{
     // SireReadClient owns the finite export/consult/download route allowlist.
     assertSireReadRequest(String(address),init?.method??'GET');
     await guarded();let response:Response|undefined;
     try{response=await fetcher(address,init);return response;}
     finally{try{await guarded();}catch(error){void response?.body?.cancel().catch(()=>{});throw error;}}
    };
    const client=new SireReadClient({ruc:c.scope.recipientRuc,clientId:s.settings.sire.clientId,
     solUsername:s.settings.sire.solUsername,clientSecret:secrets.sireClientSecret,solPassword:secrets.solPassword},
     {fetch:checkedFetch,liveAllowed:true});
    let records=0;
    for(const period of s.periods){
     await guarded();const result=await client.readPeriodDetailed(period);await guarded();
     records+=result.purchases.length+result.incidents.length;
     if(records>100)receivedFail(413,'NARROW_QUERY');
     batch.purchases.push(...result.purchases);
     for(const rejected of result.incidents)incident('SIRE_RECORD_REJECTED',{period,...rejected});
     limits(batch);
    }
   }else{
    if(!secrets.mailPassword)denied();
    const factory=this.#imapFactory??(options=>new ImapFlow(options));
    const checkedFactory:NonNullable<B2bReceptionReadOnlySourceOptions['imapFactory']>=options=>{
     const client=factory(options);
     return new Proxy(client,{get(target,key){
      const value=Reflect.get(target,key,target);
      if(typeof value!=='function')return value;
      if(!['connect','getMailboxLock','fetchAll','download'].includes(String(key)))return value.bind(target);
      return async(...args:unknown[])=>{await guarded();try{return await value.apply(target,args);}finally{await guarded();}};
     }});
    };
    await guarded();
    const cursor=await visitMailbox(s.settings.mailbox,secrets.mailPassword,s.cursor?
     {uidValidity:s.cursor.uidValidity,lastUid:BigInt(s.cursor.lastUid)}:null,async message=>{
      try{await guarded();await this.#consume(message,c.scope.recipientRuc,batch,incident);limits(batch);}
      catch(error){failure={error};throw error;}
     },true,checkedFactory,a.approvedImapHosts,{maxMessages:this.#maxMessages});
    batch.cursor={fingerprint,uidValidity:cursor.uidValidity,lastUid:String(cursor.lastUid)};
   }
   await guarded();limits(batch);return batch;
  }catch(error){if(failure)throw failure.error;if(error instanceof B2bSecurityError)throw error;throw new B2bSecurityError(503,'RECEIVED_READ_ONLY_SOURCE_UNAVAILABLE');}
  finally{for(const key of Object.keys(secrets))delete secrets[key];}
 }
 async #consume(message:MailMessage,ruc:string,batch:ReadOnlyReceptionBatch,
  incident:(code:ReadOnlyReceptionIncident['code'],metadata:unknown)=>void):Promise<void>{
  const origin={uidValidity:message.uidValidity,uid:String(message.uid)};
  if(message.errorCode||message.raw===null){incident(message.errorCode==='MAIL_TOO_LARGE'?'DOCUMENT_TOO_LARGE':'INVALID_MESSAGE',
   {...origin,errorCode:message.errorCode??'RAW_UNAVAILABLE'});return;}
  let attachments:Awaited<ReturnType<typeof mailAttachments>>;
  try{attachments=await mailAttachments(message.raw);}catch{incident('INVALID_MESSAGE',{...origin,sha256:sha(message.raw)});return;}
  const documents:PreparedMail['documents']=[],artifacts:ReceivedFile[]=[];
  for(const attachment of attachments){
   const metadata={...origin,fileName:attachment.fileName,sha256:sha(attachment.bytes)};
   let files:ReceivedFile[];
   try{
    importName(attachment.fileName);
    if(!/\.zip$/i.test(attachment.fileName)&&attachment.bytes.length>FILE_BYTES){incident('DOCUMENT_TOO_LARGE',metadata);continue;}
    if(/\.pdf$/i.test(attachment.fileName)){
     if(attachment.bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error();
     files=[{...attachment,kind:'PROVIDER_PDF'}];
    }else files=unpackReceivedFiles([attachment]);
   }catch{incident('INVALID_DOCUMENT',metadata);continue;}
   for(const file of files){
    const fileMetadata={...origin,fileName:file.fileName,sha256:sha(file.bytes)};
    if(file.bytes.length>FILE_BYTES){incident('DOCUMENT_TOO_LARGE',fileMetadata);continue;}
    try{
     importName(file.fileName);
     if(file.kind!=='XML'){artifacts.push(file);continue;}
     const parsed=prepareMailDocuments([file],ruc);
     if(parsed.documents.length!==1||parsed.rejected)throw new Error();
     documents.push(parsed.documents[0]);
    }catch{incident('INVALID_DOCUMENT',fileMetadata);}
   }
  }
  const output=documents.map(document=>({file:wire(document.file),artifacts:[] as ReadOnlyReceptionBatch['documents'][number]['artifacts']}));
  for(const file of artifacts){
   const owners=documents.flatMap((document,index)=>matches(file,document)?[index]:[]);
   const metadata={...origin,fileName:file.fileName,sha256:sha(file.bytes)};
   if(owners.length!==1){incident('ARTIFACT_UNMATCHED',metadata);continue;}
   try{if(file.kind==='CDR')validateReceivedCdr(file.bytes,documents[owners[0]].projection);}
   catch{incident('INVALID_DOCUMENT',metadata);continue;}
   output[owners[0]].artifacts.push({kind:file.kind as 'CDR'|'PROVIDER_PDF',file:wire(file)});
  }
  if(!attachments.length)incident('INVALID_MESSAGE',origin);
  batch.documents.push(...output);
 }
 toJSON(){return {source:'ReceptionReadOnlySource',configured:true};}
 [inspect.custom](){return 'B2bReceptionReadOnlySource { credentials: [PRIVATE] }';}
}
