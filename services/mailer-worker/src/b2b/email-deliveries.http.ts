import {B2bSecurityError} from './email-deliveries.security';
import {request} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {TLSSocket} from 'node:tls';
import {emailError,emailFail,emailObject,emailUuid} from './email-deliveries';
import type {B2bEmailDeliveriesPort,EmailDeliveryAccess,EmailDeliveryAction,EmailDeliveryView} from './email-deliveries.types';
const RPC='/internal/b2b/email-deliveries';
export const B2B_EMAIL_DELIVERIES_RPC=RPC;
function peer(req:IncomingMessage,peers:readonly string[]) {
  const s=req.socket as TLSSocket;
  const fingerprint=s.encrypted&&s.authorized&&s.getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();
  if(!fingerprint||!peers.includes(fingerprint))emailFail(403,'EMAIL_PRIVATE_PEER_REQUIRED');
}
function token(req:IncomingMessage):string {
  const names=req.rawHeaders.filter((_x,i)=>i%2===0).map(x=>x.toLowerCase());
  if(new Set(names).size!==names.length||typeof req.headers.authorization!=='string'||
    !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(req.headers.authorization))emailFail(401,'INVALID_PRINCIPAL');
  return req.headers.authorization!.slice(7);
}
async function body(req:IncomingMessage) {
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(req.headers['content-type']??'')))emailFail(400,'INVALID_REQUEST');
  // Supports a contextual server's bounded rawBody; parsed req.body is never trusted.
  const raw=(req as IncomingMessage&{rawBody?:unknown}).rawBody;
  let bytes:Buffer;
  if(raw!==undefined) {
    if(!Buffer.isBuffer(raw)||raw.length>16384)emailFail(400,'INVALID_REQUEST');
    bytes=Buffer.from(raw as Buffer);
  } else {
    bytes=await new Promise<Buffer>((resolve,reject)=>{
      const chunks:Buffer[]=[];let size=0,failed=false;
      req.on('data',(chunk:Buffer)=>{if(failed)return;size+=chunk.length;if(size>16384){failed=true;reject(new B2bSecurityError(400,'INVALID_REQUEST'));}else chunks.push(Buffer.from(chunk));});
      req.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks));});
      req.on('error',()=>reject(new B2bSecurityError(400,'INVALID_REQUEST')));
      req.on('aborted',()=>reject(new B2bSecurityError(400,'INVALID_REQUEST')));
    });
  }
  try {return JSON.parse(bytes.toString('utf8'));}catch{emailFail(400,'INVALID_REQUEST');}
}
function send(res:ServerResponse,status:number,value:unknown) {
  res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.end(JSON.stringify(value));
}
function validView(v:any):v is EmailDeliveryView {
  return !!v&&v.schemaVersion==='factuez.b2b.email-deliveries.v1'&&v.environment==='BETA'&&v.candidateOnly===true&&
    v.deliveredToClient===false&&v.fiscalAuthority===false&&emailUuid(v.id)&&emailUuid(v.documentId)&&
    ['QUEUED','WAITING_ARTIFACTS','DISPATCHING','CAPTURED_LOCAL','SMTP_ACCEPTED','UNKNOWN'].includes(v.state)&&
    ['NONE','LOCAL_CAPTURE','CORPORATE'].includes(v.profile)&&!('recipient' in v)&&!('token' in v)&&!('corporate' in v)&&
    Array.isArray(v.attachments)&&v.attachments.length<=3&&Buffer.byteLength(JSON.stringify(v))<=16384;
}
/** Opt-in handler only. Main/QA composition is deliberately not modified. RUN has no HTTP representation. */
export function createB2bEmailDeliveriesHandler(core:B2bEmailDeliveriesPort,peers:readonly string[],mode:'PUBLIC'|'OWNER_RPC') {
  if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p))||!['PUBLIC','OWNER_RPC'].includes(mode))emailFail(400,'INVALID_REQUEST');
  const allowed=[...peers];
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    try {
    if(!req.url?.startsWith('/')||req.url.startsWith('//'))emailFail(400,'INVALID_REQUEST');
    const url=new URL(req.url??'/','https://email.invalid'),create=/^\/(?:b2b\/v1\/)?documents\/([a-f0-9-]+)\/email-deliveries$/.exec(url.pathname),
      read=/^\/(?:b2b\/v1\/)?email-deliveries\/([a-f0-9-]+)$/.exec(url.pathname);
    if(mode==='OWNER_RPC'?url.pathname!==RPC:!create&&!read)return false;
      peer(req,allowed);const bearer=token(req);
      const qs=[...url.searchParams.keys()];
      if(qs.length>1||qs.some(k=>k!=='environment')||qs.length&&url.searchParams.get('environment')!=='BETA')emailFail(400,'INVALID_REQUEST');
      let action:EmailDeliveryAction,input:unknown,kind:EmailDeliveryAccess['kind'];
      if(mode==='OWNER_RPC') {
        if(req.method!=='POST'||url.search)emailFail(400,'INVALID_REQUEST');
        const b=emailObject(await body(req),['kind','action','input']);
        if(!['CREATE','READ'].includes(b.action)||!['SERVICE','USER'].includes(b.kind))emailFail(400,'INVALID_REQUEST');
        action=b.action;kind=b.kind;input=b.input;
      } else {
        const k=req.headers['x-factuez-actor-kind'];if(k!=='SERVICE'&&k!=='USER')emailFail(401,'INVALID_PRINCIPAL');kind=k as EmailDeliveryAccess['kind'];
        if(create) {
          if(req.method!=='POST'||!emailUuid(create[1])||typeof req.headers['idempotency-key']!=='string')emailFail(400,'INVALID_REQUEST');
          const b=emailObject(await body(req),['binding','recipient','format']);action='CREATE';
          input={...b,documentId:create[1],idempotencyKey:req.headers['idempotency-key']};
        } else {
          if(req.method!=='GET'||!emailUuid(read![1])||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0)emailFail(400,'INVALID_REQUEST');
          action='READ';input={id:read![1]};
        }
      }
      const result=await core.execute({token:bearer,kind},action,input);
      if(!validView(result))emailFail(503,'EMAIL_OWNER_UNAVAILABLE');
      send(res,mode==='PUBLIC'&&action==='CREATE'?202:200,result);
    } catch(e) {const error=emailError(e);send(res,mode==='OWNER_RPC'?200:error.status,{error:{status:error.status,code:error.code}});}
    return true;
  };
}
/** Dedicated fixed mTLS RPC; does not expand shared private HTTP allowlists. */
export class HttpB2bEmailDeliveries implements B2bEmailDeliveriesPort {
  private readonly origin:URL;
  constructor(origin:string,private readonly tls:{ca:Buffer;cert:Buffer;key:Buffer}) {
    this.origin=new URL(origin);
    if(this.origin.protocol!=='https:'||this.origin.pathname!=='/'||this.origin.username||this.origin.password||this.origin.search||this.origin.hash)emailFail(400,'INVALID_REQUEST');
  }
  async execute(access:EmailDeliveryAccess,action:EmailDeliveryAction,input:unknown):Promise<EmailDeliveryView> {
    if(!['CREATE','READ'].includes(action)||!['USER','SERVICE'].includes(access.kind)||!/^[A-Za-z0-9._~-]{1,8192}$/.test(access.token))emailFail(400,'INVALID_REQUEST');
    const bytes=Buffer.from(JSON.stringify({kind:access.kind,action,input}));if(bytes.length>16384)emailFail(400,'INVALID_REQUEST');
    return new Promise((resolve,reject)=>{
      const fail=()=>reject(emailError(null));
      const req=request(new URL(RPC,this.origin),{...this.tls,method:'POST',rejectUnauthorized:true,timeout:10000,
        headers:{Authorization:'Bearer '+access.token,'Content-Type':'application/json','Content-Length':String(bytes.length)}},res=>{
        let size=0;const chunks:Buffer[]=[];
        res.on('data',(b:Buffer)=>{size+=b.length;if(size>16384)req.destroy();else chunks.push(b);});
        res.on('error',fail);res.on('aborted',fail);
        res.on('end',()=>{
          try {
            if(!/^application\/json(?:;|$)/.test(String(res.headers['content-type']??'')))return fail();
            const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if(res.statusCode!==200||v?.error) {
              const e=emailError(Object.assign(new B2bSecurityError(
                [400,401,403,404,409,503].includes(v?.error?.status)?v.error.status:503,v?.error?.code)));
              return reject(e);
            }
            if(!validView(v))return fail();resolve(v);
          } catch {fail();}
        });
      });req.on('timeout',()=>req.destroy());req.on('error',fail);req.end(bytes);
    });
  }
}

