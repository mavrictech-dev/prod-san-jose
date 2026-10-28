import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { checkServerIdentity, createSecureContext } from 'node:tls';
import { TextDecoder, types } from 'node:util';
import { B2bSdkError } from './types';
import * as wire from './validation';
export interface FactuEzB2bOptions {
  /** HTTPS origin only, no path/query/credentials. Private DNS/VPN is configured by TI. */
  origin: string;
  tls: { ca: Buffer; cert: Buffer; key: Buffer; serverCertificateSha256: string };
  /** Called anew for EVERY HTTP request. No PWA cookies, JWT decoding or token cache. */
  bearer: () => Promise<{ token: string; actorKind: 'SERVICE'|'USER' }>;
  timeoutMs?: number;
  maxJsonBytes?: number;
}

export interface FactuEzB2bAdminOptions extends Omit<FactuEzB2bOptions,'bearer'> {
  /** Current independent human step-up proof; never a SERVICE/PWA fallback. */
  adminBearer:()=>Promise<string>;
}
interface Reply { bytes:Buffer; headers:import('node:http').IncomingHttpHeaders }
const JSON_LIMIT=16*1024*1024;
const routes={
  capabilities:['GET','capabilities',0],receivedList:['GET','received-documents',0],receivedDetail:['GET','received-documents/{0}',1],
  receivedManifest:['GET','received-documents/{0}/artifacts',1],receivedContent:['GET','received-documents/{0}/artifacts/{1}/content',2],
  customers:['GET','customers',0],customer:['GET','customers/{0}',1],customerCreate:['POST','customers',0],customerUpdate:['PATCH','customers/{0}',1],
  products:['GET','business-products',0],productCreate:['POST','products',0],productUpdate:['PATCH','products/{0}',1],
  shifts:['GET','shifts',0],shiftOpen:['POST','shifts',0],shiftClose:['POST','shifts/{0}/close',1],cash:['POST','shifts/{0}/cash-movements',1],summary:['GET','business-summary',0],
  receivedImport:['POST','received-documents',0],receivedAttach:['POST','received-documents/{0}/artifacts',1],receivedAssign:['PATCH','received-documents/{0}/assignment',1],receivedRegister:['PATCH','received-documents/{0}/registration',1],
  dashboard:['GET','dashboard',0],reportCreate:['POST','report-jobs',0],reportRead:['GET','report-jobs/{0}',1],reportContent:['GET','report-jobs/{0}/content',1],
  adminList:['GET','admin/applications',0],adminRead:['GET','admin/applications/{0}',1],adminCreate:['POST','admin/applications',0],adminUpdate:['PATCH','admin/applications/{0}',1],adminRotate:['POST','admin/applications/{0}/rotate-secret',1],
  ownerMasters:['GET','admin/masters',0],ownerIssuerCreate:['POST','admin/issuers',0],ownerIssuerUpdate:['PATCH','admin/issuers/{0}',1],
  ownerBranchCreate:['POST','admin/branches',0],ownerBranchUpdate:['PATCH','admin/branches/{0}',1],ownerPointCreate:['POST','admin/branches/{0}/points',1],ownerPointUpdate:['PATCH','admin/points/{0}',1],ownerSeriesCreate:['POST','admin/points/{0}/series',1],ownerSeriesUpdate:['PATCH','admin/series/{0}',1],
  ownerUsers:['GET','admin/users',0],ownerUserCreate:['POST','admin/users',0],ownerUserUpdate:['PATCH','admin/users/{0}/access',1],ownerRoles:['GET','admin/roles',0],ownerRoleUpdate:['PATCH','admin/roles/{0}',1],
  ownerPrintRead:['GET','admin/print-profiles/{0}',1],ownerPrintSave:['PATCH','admin/print-profiles/{0}',1],ownerPrintPreview:['POST','admin/print-profiles/{0}/preview',1],
  ownerFiscalRead:['GET','admin/fiscal-config/{0}/readiness',1],ownerFiscalAudit:['GET','admin/fiscal-config/{0}/audit',1],ownerFiscalSave:['POST','admin/fiscal-config/{0}/replacements',1],ownerSmtpRead:['GET','admin/mail-config/{0}',1],ownerSmtpSave:['POST','admin/mail-config/{0}/replacements',1],
  receptionConfigRead:['GET','admin/received-connectors/{0}',1],receptionConfigSave:['PATCH','admin/received-connectors/{0}',1],receptionSyncCreate:['POST','received-sync-jobs',0],receptionSyncRead:['GET','received-sync-jobs/{0}',1],
  historyList:['GET','history/documents',0],historyDetail:['GET','history/documents/{0}',1],historyContent:['GET','history/documents/{0}/artifacts/{1}',2],emailCreate:['POST','documents/{0}/email-deliveries',1],emailRead:['GET','email-deliveries/{0}',1],
} as const;
export type Operation=keyof typeof routes;
export interface RequestExtras {stepUpHandle?:string}
const expandedBodyOperations:readonly Operation[]=['ownerPrintSave','ownerPrintPreview','ownerFiscalSave','ownerSmtpSave'];
const historicalArtifactKinds=['UNSIGNED_XML','SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP','PDF_TICKET_80MM','PDF_A4','DELIVERY_ZIP'];
function validRouteId(op:Operation,index:number,id:string){
  if(typeof id!=='string')return false;
  if(op==='ownerRoleUpdate')return ['ADMIN','STATION_MANAGER','CASHIER','TRACK_OPERATOR','AUDITOR'].includes(id);
  if(['ownerIssuerUpdate','ownerPrintRead','ownerPrintSave','ownerPrintPreview','ownerFiscalRead','ownerFiscalAudit','ownerFiscalSave','ownerSmtpRead','ownerSmtpSave','receptionConfigRead','receptionConfigSave'].includes(op))return /^[1-9][0-9]{0,9}$/.test(id)&&Number(id)<=2147483647;
  if(op==='historyDetail'||op==='historyContent')return index===0?/^[a-f0-9]{64}$/.test(id):historicalArtifactKinds.includes(id);
  return wire.uuid(id);
}
/** Internal bounded transport. Its only dispatch surface is a closed operation vocabulary. */
export class BoundedTransport {
  #origin:URL;
  #tls:FactuEzB2bOptions['tls'];
  #bearer:()=>Promise<{token:string;actorKind?:'SERVICE'|'USER'}>;
  #admin:boolean;
  #timeout:number;
  #jsonLimit:number;
  constructor(options:FactuEzB2bOptions | FactuEzB2bAdminOptions, admin:boolean) {
    try {
      if(types.isProxy(options))throw 0;
      wire.object(options);
      if(Reflect.ownKeys(options).some(k=>typeof k!=='string'||!Object.getOwnPropertyDescriptor(options,k)?.enumerable))throw 0;
      if(Object.keys(options).some(k=>!['origin','tls',...(admin?['adminBearer']:['bearer']),'timeoutMs','maxJsonBytes'].includes(k)))throw 0;
      if(typeof options.origin!=='string')throw 0;
      const u=new URL(options.origin);
      if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||typeof (admin?(options as FactuEzB2bAdminOptions).adminBearer:(options as FactuEzB2bOptions).bearer)!=='function')throw 0;
      if(types.isProxy(options.tls)||Reflect.ownKeys(options.tls).some(k=>typeof k!=='string'||!Object.getOwnPropertyDescriptor(options.tls,k)?.enumerable))throw 0;
      wire.exact(options.tls,['ca','cert','key','serverCertificateSha256']);
      for(const k of ['ca','cert','key'] as const)if(!Buffer.isBuffer(options.tls[k])||options.tls[k].length<1||options.tls[k].length>1024*1024)throw 0;
      if(typeof options.tls.serverCertificateSha256!=='string'||!/^[a-f0-9]{64}$/.test(options.tls.serverCertificateSha256))throw 0;
      const timeout=options.timeoutMs??30000,limit=options.maxJsonBytes??JSON_LIMIT;
      if(!Number.isSafeInteger(timeout)||timeout<100||timeout>120000||!Number.isSafeInteger(limit)||limit<1024||limit>JSON_LIMIT)throw 0;
      const tls={ca:Buffer.from(options.tls.ca),cert:Buffer.from(options.tls.cert),key:Buffer.from(options.tls.key),serverCertificateSha256:options.tls.serverCertificateSha256};
      createSecureContext({...tls,minVersion:'TLSv1.2'});
      const adminProvider=(options as FactuEzB2bAdminOptions).adminBearer;
      this.#origin=u;this.#tls=tls;this.#bearer=admin?async()=>({token:await adminProvider()}):(options as FactuEzB2bOptions).bearer;this.#admin=admin;this.#timeout=timeout;this.#jsonLimit=limit;
    } catch {throw new B2bSdkError('INVALID_CONFIGURATION');}
  }
  async #request(path:string,query:Record<string,string>,maximum:number,method:'GET'|'POST'|'PATCH',binary:boolean,body:Buffer|undefined,key:string|undefined,expectedStatus:number,humanOnly:boolean,stepUpHandle?:string):Promise<Reply> {
    // Even a hanging credential provider is bounded. Its exception text is never returned.
    const started=Date.now();let credentials:{token:string;actorKind?:'SERVICE'|'USER'};
    let tokenTimer:ReturnType<typeof setTimeout>|undefined;
    try {
      credentials=snapshot(await Promise.race([this.#bearer(),new Promise<never>((_r,reject)=>{tokenTimer=setTimeout(()=>reject(new B2bSdkError('REQUEST_TIMEOUT')),this.#timeout);})]));
      wire.exact(credentials,this.#admin?['token']:['token','actorKind']);
      if(typeof credentials.token!=='string'||!/^[-A-Za-z0-9._~]{1,8192}$/.test(credentials.token)||(this.#admin?credentials.actorKind!==undefined:!['SERVICE','USER'].includes(credentials.actorKind!))||humanOnly&&credentials.actorKind!=='USER')throw 0;
    } catch(error) {throw new B2bSdkError(error instanceof B2bSdkError&&error.code==='REQUEST_TIMEOUT'?'REQUEST_TIMEOUT':'TOKEN_UNAVAILABLE');}
    finally {clearTimeout(tokenTimer);}
    const url=new URL(path,this.#origin);url.search=new URLSearchParams(query).toString();
    return new Promise((resolve,reject)=>{
      let settled=false;let deadline:ReturnType<typeof setTimeout>|undefined;
      const finish=(error:B2bSdkError|undefined,value?:Reply)=>{if(settled)return;settled=true;clearTimeout(deadline);if(error)reject(error);else resolve(value!);};
      const expectedPin=this.#tls.serverCertificateSha256;
      const req=request(url,{
        method,agent:false,ca:this.#tls.ca,cert:this.#tls.cert,key:this.#tls.key,
        rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:16384,
        checkServerIdentity(host,cert){
          const invalid=checkServerIdentity(host,cert);if(invalid)return invalid;
          if(!cert.raw||createHash('sha256').update(cert.raw).digest('hex')!==expectedPin)return new Error('SERVER_CERTIFICATE_MISMATCH');
          return undefined;
        },
        headers:{Authorization:`Bearer ${credentials.token}`,...(this.#admin?{}:{'X-FactuEz-Actor-Kind':credentials.actorKind!}),...(stepUpHandle?{'X-FactuEz-Step-Up':stepUpHandle}:{}),...(key?{'Idempotency-Key':key}:{}),...(body?{'Content-Type':'application/json','Content-Length':String(body.length)}:{}),Accept:binary?'application/octet-stream':'application/json','Accept-Encoding':'identity','Cache-Control':'no-store'},
      },res=>{
        const rejectResponse=(error:B2bSdkError)=>{finish(error);res.destroy();req.destroy();};
        const status=res.statusCode??0;
        if(status>=300&&status<400)return rejectResponse(new B2bSdkError('REDIRECT_REFUSED',status));
        if(status!==expectedStatus)return rejectResponse(new B2bSdkError('REMOTE_REQUEST_FAILED',status>=100&&status<=599?status:undefined));
        const names=res.rawHeaders.filter((_v,i)=>i%2===0).map(n=>n.toLowerCase());
        if(new Set(names).size!==names.length||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||
          res.headers['set-cookie']!==undefined)return rejectResponse(new B2bSdkError('INVALID_RESPONSE'));
        const len=res.headers['content-length'];
        if(len!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(len)||!Number.isSafeInteger(Number(len))))return rejectResponse(new B2bSdkError('INVALID_RESPONSE'));
        if(len!==undefined&&Number(len)>maximum)return rejectResponse(new B2bSdkError('RESPONSE_TOO_LARGE'));
        const chunks:Buffer[]=[];let size=0;
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maximum)return rejectResponse(new B2bSdkError('RESPONSE_TOO_LARGE'));chunks.push(chunk);});
        res.on('error',()=>finish(new B2bSdkError('TLS_OR_NETWORK_ERROR')));
        res.on('aborted',()=>finish(new B2bSdkError('INVALID_RESPONSE')));
        res.on('end',()=>{
          if(!res.complete||len!==undefined&&size!==Number(len))return finish(new B2bSdkError('INVALID_RESPONSE'));
          finish(undefined,{bytes:Buffer.concat(chunks,size),headers:res.headers});
        });
      });
      req.on('error',()=>finish(new B2bSdkError('TLS_OR_NETWORK_ERROR')));
      deadline=setTimeout(()=>{finish(new B2bSdkError('REQUEST_TIMEOUT'));req.destroy();},Math.max(1,this.#timeout-(Date.now()-started)));
      req.end(body);
    });
  }

  async #call(op:Operation,ids:string[],query:Record<string,string>,body:unknown,key:string|undefined,file:boolean,maximum?:number,extras?:RequestExtras):Promise<Reply>{
    if(!Object.hasOwn(routes,op)||op.startsWith('admin')!==this.#admin)throw new B2bSdkError('INVALID_REQUEST');
    const [method,template,count]=routes[op];
    if(ids.length!==count||ids.some((id,i)=>!validRouteId(op,i,id))||file!==['receivedContent','reportContent','historyContent'].includes(op)||method==='GET'&&(body!==undefined||key!==undefined))throw new B2bSdkError('INVALID_REQUEST');
    const extra=snapshot(extras??{});wire.exact(extra,Object.hasOwn(extra,'stepUpHandle')?['stepUpHandle']:[]);
    if(extra.stepUpHandle!==undefined&&(!op.startsWith('reception')||typeof extra.stepUpHandle!=='string'||!/^[-A-Za-z0-9._~]{1,8192}$/.test(extra.stepUpHandle)))throw new B2bSdkError('INVALID_REQUEST');
    const path='/b2b/v1/'+template.replace(/\{([01])\}/g,(_m,i)=>ids[Number(i)]);
    let encoded:Buffer|undefined;
    const bodyLimit=expandedBodyOperations.includes(op)?1024*1024:128*1024;
    if(body!==undefined){encoded=Buffer.from(JSON.stringify(snapshot(body,bodyLimit)));if(encoded.length>bodyLimit)throw new B2bSdkError('INVALID_REQUEST');}
    if(key!==undefined&&(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(key)))throw new B2bSdkError('INVALID_REQUEST');
    const cap=file?(op==='reportContent'?24*1024*1024:10*1024*1024):op.startsWith('owner')||op.startsWith('history')||op.startsWith('reception')||op.startsWith('email')?Math.min(this.#jsonLimit,2*1024*1024):this.#jsonLimit;
    if(maximum!==undefined&&(!Number.isSafeInteger(maximum)||maximum<1||maximum>cap))throw new B2bSdkError('INVALID_REQUEST');
    const expectedStatus=op==='emailCreate'?202:method==='POST'&&op!=='adminRotate'?201:200;
    return this.#request(path,query,maximum??cap,method,file,encoded,key,expectedStatus,op.startsWith('owner')||op.startsWith('receptionConfig'),extra.stepUpHandle);
  }
  file(op:'receivedContent'|'reportContent'|'historyContent',ids:string[],query:Record<string,string>,maximum:number){return this.#call(op,ids,query,undefined,undefined,true,maximum);}
  async json(op:Operation,ids:string[],query:Record<string,string>,body?:unknown,key?:string,extras?:RequestExtras):Promise<unknown>{
    const reply=await this.#call(op,ids,query,body,key,false,undefined,extras);
    if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(reply.headers['content-type']??''))wire.fail();
    try {
      // Reject malformed UTF-8, duplicate keys, prototype keys and silently normalized JSON.
      const source=new TextDecoder('utf-8',{fatal:true}).decode(reply.bytes);
      const value:unknown=JSON.parse(source);validateJsonTree(value,0,op==='ownerPrintPreview');
      rejectDuplicateKeys(source);
      return value;
    }catch{throw new B2bSdkError('INVALID_RESPONSE');}
  }
}
/** Detach caller input before the first await, without invoking getters, proxies or toJSON. */
export function snapshot<T>(value:T,maxStringLength=128*1024):T {
  if(!Number.isSafeInteger(maxStringLength)||maxStringLength<1||maxStringLength>2_000_000)wire.fail('INVALID_REQUEST');
  const seen=new WeakSet<object>();let nodes=0;
  const copy=(v:any,depth:number):any=>{
    if(++nodes>400000||depth>32)wire.fail('INVALID_REQUEST');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'){if(v.length>maxStringLength)wire.fail('INVALID_REQUEST');return v;}
    if(!v||typeof v!=='object'||types.isProxy(v)||seen.has(v))wire.fail('INVALID_REQUEST');
    const arr=Array.isArray(v),proto=Object.getPrototypeOf(v);
    if(arr?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)wire.fail('INVALID_REQUEST');
    seen.add(v);const out:any=arr?[]:{},desc=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(desc);
    if(arr&&(v.length>1000||keys.length!==v.length+1))wire.fail('INVALID_REQUEST');
    for(const k of keys){if(typeof k!=='string'||['__proto__','constructor','prototype','toJSON'].includes(k))wire.fail('INVALID_REQUEST');
      if(arr&&k==='length')continue;const d=desc[k];if(!d.enumerable||!Object.hasOwn(d,'value')||arr&&!/^(0|[1-9][0-9]*)$/.test(k))wire.fail('INVALID_REQUEST');out[k]=copy(d.value,depth+1);}
    seen.delete(v);return out;
  };
  return copy(value,0);
}
function validateJsonTree(v:unknown,depth=0,preview=false,path=''):void {
  if(depth>32)wire.fail();
  if(Array.isArray(v)){if(v.length>1000)wire.fail();for(const i of v)validateJsonTree(i,depth+1,preview,path+'[]');}
  else if(v&&typeof v==='object'){wire.object(v);for(const [k,i] of Object.entries(v))validateJsonTree(i,depth+1,preview,path?path+'.'+k:k);}
  else if(typeof v==='string'&&v.length>(preview&&path==='data.base64'?2_000_000:81958)||typeof v==='number'&&!Number.isFinite(v))wire.fail();
}
/** JSON.parse normally discards duplicate members; scan the already-valid JSON before accepting it. */
function rejectDuplicateKeys(source:string):void {
  const stack:({object:true;keys:Set<string>;expectKey:boolean}|{object:false})[]=[];
  for(let i=0;i<source.length;i++){
    const c=source[i];if(c==='"'){
      const start=i++;for(;i<source.length;i++){if(source[i]==='\\'){i++;continue;}if(source[i]==='"')break;}
      const frame=stack.at(-1);
      if(frame?.object&&frame.expectKey){const key=JSON.parse(source.slice(start,i+1));if(frame.keys.has(key))wire.fail();frame.keys.add(key);frame.expectKey=false;}
    }else if(c==='{')stack.push({object:true,keys:new Set(),expectKey:true});
    else if(c==='[')stack.push({object:false});
    else if(c==='}'||c===']')stack.pop();
    else if(c===','){const frame=stack.at(-1);if(frame?.object)frame.expectKey=true;}
  }
}
