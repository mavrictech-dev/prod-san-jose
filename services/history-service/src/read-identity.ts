import { KeyObject, createPublicKey, verify } from 'node:crypto';
import { validScope, type AccessTokenClaims } from '@factuez/contracts';
import { historicalSha256, historyJson, historyUuid } from '@factuez/history-core';
import { historyActor, type HistoryIdentityPort } from './access';

export class HistoryReadAccessError extends Error {
  constructor(readonly status:number,readonly code:string){super(code);delete this.stack;}
}
function requireAccess(ok:unknown,status:number,code:string):asserts ok{
  if(!ok)throw new HistoryReadAccessError(status,code);
}
type Options={publicKey:KeyObject|string|Buffer;issuer:string;audience:string;identityBaseUrl:string;
  fetcher?:typeof fetch;now?:()=>number};

/** RS256 locally + fresh Identity authority; never accepts request user/roles headers.
 * Existing document.view grants read-only history.view. No import permission mapping.
 */
export class HistoryReadIdentityAdapter implements HistoryIdentityPort {
  private readonly key:KeyObject;
  private readonly url:string;
  private readonly fetcher:typeof fetch;
  private readonly now:()=>number;
  constructor(private readonly options:Options){
    this.options=Object.freeze({...options});
    let origin:URL;
    try{origin=new URL(options.identityBaseUrl);}catch{throw new HistoryReadAccessError(503,'HISTORY_IDENTITY_CONFIG_INVALID');}
    requireAccess(origin.origin===options.identityBaseUrl&&!origin.username&&!origin.password&&origin.protocol==='http:'&&
      (origin.origin==='http://identity-service:3001'||origin.hostname==='127.0.0.1'&&Number(origin.port)>1024),503,'HISTORY_IDENTITY_CONFIG_INVALID');
    requireAccess(/^[a-zA-Z0-9_.-]{1,80}$/.test(options.issuer)&&/^[a-zA-Z0-9_.-]{1,80}$/.test(options.audience),503,'HISTORY_IDENTITY_CONFIG_INVALID');
    if(options.publicKey instanceof KeyObject){
      requireAccess(options.publicKey.type==='public',503,'HISTORY_PUBLIC_KEY_REQUIRED');this.key=options.publicKey;
    }else{
      const pem=Buffer.isBuffer(options.publicKey)?options.publicKey.toString('utf8'):options.publicKey;
      requireAccess(typeof pem==='string'&&pem.length<=16000&&/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(pem),503,'HISTORY_PUBLIC_KEY_REQUIRED');
      try{this.key=createPublicKey(pem);}catch{throw new HistoryReadAccessError(503,'HISTORY_PUBLIC_KEY_REQUIRED');}
    }
    requireAccess(this.key.asymmetricKeyType==='rsa'&&(this.key.asymmetricKeyDetails?.modulusLength??0)>=2048,503,'HISTORY_PUBLIC_KEY_REQUIRED');
    this.url=`${origin.origin}/api/v1/auth/me`;this.fetcher=options.fetcher??fetch;this.now=options.now??Date.now;
  }
  private claims(input:unknown):AccessTokenClaims{
    try{
      const c=historyJson(input),now=Math.floor(this.now()/1000);
      requireAccess(c&&typeof c==='object'&&!Array.isArray(c)&&c.iss===this.options.issuer&&
        (typeof c.aud==='string'?c.aud===this.options.audience:Array.isArray(c.aud)&&c.aud.length<=10&&
          c.aud.every((s:unknown)=>typeof s==='string')&&c.aud.includes(this.options.audience))&&
        Number.isSafeInteger(c.exp)&&c.exp>now&&Number.isSafeInteger(c.iat)&&c.iat<=now+30&&c.iat<c.exp&&
        (c.nbf===undefined||Number.isSafeInteger(c.nbf)&&c.nbf<=now)&&Number.isSafeInteger(c.authVersion)&&c.authVersion>=0&&
        Array.isArray(c.roles)&&Array.isArray(c.permissions)&&validScope(c.scope,c.roles),401,'HISTORY_SESSION_INVALID');
      historyUuid(c.sub);
      requireAccess(c.browserSessionId===undefined||typeof c.browserSessionId==='string'&&/^[a-f0-9]{64}$/.test(c.browserSessionId),401,'HISTORY_SESSION_INVALID');
      return c as AccessTokenClaims;
    }catch(error){throw error instanceof HistoryReadAccessError?error:new HistoryReadAccessError(401,'HISTORY_SESSION_INVALID');}
  }
  private actor(c:AccessTokenClaims){
    requireAccess(c.permissions.includes('document.view'),403,'HISTORY_PERMISSION_DENIED');
    try{return historyActor({userId:c.sub,roles:[...c.roles].sort(),permissions:['history.view'],scope:c.scope.kind==='GLOBAL'?{kind:'GLOBAL'}:
      {kind:'ASSIGNED',branchIds:[...c.scope.branchIds].sort(),emissionPointIds:[...c.scope.emissionPointIds].sort(),seriesCounterIds:[...c.scope.series].sort()}},'history.view');}
    catch{throw new HistoryReadAccessError(401,'HISTORY_SESSION_INVALID');}
  }
  private signed(token:string){
    requireAccess(typeof token==='string'&&token.length<=8192&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),401,'HISTORY_SESSION_REQUIRED');
    try{
      const parts=token.split('.');requireAccess(parts.every(s=>Buffer.from(s,'base64url').toString('base64url')===s),401,'HISTORY_SESSION_INVALID');
      const h=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
      requireAccess(h.alg==='RS256'&&(h.typ===undefined||h.typ==='JWT')&&h.crit===undefined&&h.b64===undefined,401,'HISTORY_SESSION_INVALID');
      requireAccess(verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),this.key,Buffer.from(parts[2],'base64url')),401,'HISTORY_SESSION_INVALID');
      return this.claims(JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')));
    }catch(error){throw error instanceof HistoryReadAccessError?error:new HistoryReadAccessError(401,'HISTORY_SESSION_INVALID');}
  }
  private async current(token:string){
    let response:Response;
    try{response=await this.fetcher(this.url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json','Cache-Control':'no-store'},
      redirect:'error',signal:AbortSignal.timeout(4000)});}catch{throw new HistoryReadAccessError(503,'HISTORY_IDENTITY_UNAVAILABLE');}
    if(!response.ok){await response.body?.cancel();throw new HistoryReadAccessError([401,403].includes(response.status)?401:503,
      [401,403].includes(response.status)?'HISTORY_SESSION_REVOKED':'HISTORY_IDENTITY_UNAVAILABLE');}
    if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')||!response.body){
      await response.body?.cancel();throw new HistoryReadAccessError(503,'HISTORY_IDENTITY_UNAVAILABLE');
    }
    const reader=response.body.getReader();
    const parts:Uint8Array[]=[];let length=0;
    try{
      while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;
        requireAccess(length<=65536,503,'HISTORY_IDENTITY_UNAVAILABLE');parts.push(part.value);}
      return this.claims(JSON.parse(Buffer.concat(parts).toString('utf8')));
    }catch(error){await reader.cancel().catch(()=>{});throw error instanceof HistoryReadAccessError?error:new HistoryReadAccessError(503,'HISTORY_IDENTITY_UNAVAILABLE');}
  }
  async authorize(credential:string,permission:'history.import'|'history.view'){
    requireAccess(permission==='history.view',403,'HISTORY_READ_ONLY');
    const signed=this.signed(credential),actor=this.actor(signed),current=await this.current(credential),fresh=this.actor(current);
    requireAccess(signed.sub===current.sub&&signed.authVersion===current.authVersion&&signed.browserSessionId===current.browserSessionId&&
      historicalSha256(actor)===historicalSha256(fresh),401,'HISTORY_SESSION_CHANGED');
    return fresh;
  }
}
