import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {AccessTokenClaims} from '@factuez/contracts';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {AuthService} from '../application/auth.service';
import type {PasswordService} from '../application/password.service';
import {fail,plain,type AdminAuthority,type Store} from './model';

export const onpremRequiredPermissions=['setup.manage','user.manage','role.manage'] as const;
export const onpremSessionCookie='__Secure-factuez_b2b_onprem';
export const onpremSessionPath='/api/v1/b2b-admin';
const TTL=120000,hash=(s:string)=>createHash('sha256').update(s).digest('hex');
type Live={id:string;authVersion:number;passwordHash:string;stamp:string};
type Session={id:string;userId:string;authVersion:number;browserSessionId:string;origin:string;csrf:string;expiresAt:number;verifiedUntil:number;stamp:string|null};
export interface OnpremRequest {headers:Record<string,string|string[]|undefined>}
type Frame={request:OnpremRequest;sessionId:string;proof:string};
export interface OnpremAdminDependencies {
 auth:Pick<AuthService,'verifyAccessToken'|'assertActive'>;
 passwords:Pick<PasswordService,'verify'>;
 db:Pick<PrismaService,'user'>;
 store:Store;
}
/** In-memory step-up records only. Authoritative passwords, RBAC, audit and
 * client records remain in the existing Identity owner database. No JWT step-up
 * claim, username override or request-supplied user is accepted. */
export class OnpremVerifiedAdminAuthority implements AdminAuthority {
 #sessions=new Map<string,Session>();#context=new AsyncLocalStorage<Frame>();#reauthUsers=new Set<string>();#closed=false;
 constructor(private readonly deps:OnpremAdminDependencies,private readonly origins:readonly string[],private readonly now=Date.now){
  if(!origins.length||origins.length>8||origins.some(origin=>{try{const u=new URL(origin);return u.protocol!=='https:'||u.origin!==origin;}catch{return true;}}))throw Error('ONPREM_TRUSTED_HTTPS_ORIGINS_REQUIRED');
 }
 boundary(req:OnpremRequest){
  const h=req.headers,origin=h.origin;
  if(this.#closed||typeof origin!=='string'||!this.origins.includes(origin)||h['x-factuez-b2b-admin']!=='ONPREM'||
   h['sec-fetch-site']!==undefined&&h['sec-fetch-site']!=='same-origin')return fail(403,'ONPREM_ORIGIN_OR_CSRF_REQUIRED');
  return origin;
 }
 private token(req:OnpremRequest){
  const h=req.headers.authorization;
  if(typeof h!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(h))return fail(401,'INVALID_TOKEN');
  return h.slice(7);
 }
 private async actor(req:OnpremRequest):Promise<{claims:AccessTokenClaims;live:Live;origin:string}>{
  const origin=this.boundary(req);let c:AccessTokenClaims;
  try{c=this.deps.auth.verifyAccessToken(this.token(req));await this.deps.auth.assertActive(c);}
  catch(e){return this.authError(e);}
  if(c.scope?.kind!=='GLOBAL'||!c.roles.includes('ADMIN')||onpremRequiredPermissions.some(p=>!c.permissions.includes(p))||
   typeof c.browserSessionId!=='string'||!/^[a-f0-9]{64}$/.test(c.browserSessionId))return fail(403,'ONPREM_GLOBAL_BROWSER_ADMIN_REQUIRED');
  const live=await this.live(c.sub,c.authVersion);
  return {claims:c,live,origin};
 }
 private authError(error:unknown):never{
  const e=error as {getStatus?:()=>number;status?:number};
  return fail((typeof e?.getStatus==='function'?e.getStatus():e?.status)===401?401:503,'ONPREM_CURRENT_AUTH_UNAVAILABLE');
 }
 private async live(id:string,revision:number):Promise<Live>{
  const u=await this.deps.db.user.findUnique({where:{id},select:{id:true,active:true,authVersion:true,passwordHash:true,
   roles:{select:{role:{select:{code:true,active:true,permissions:{select:{permission:{select:{code:true}}}}}}}}}});
  if(!u?.active||u.authVersion!==revision)return fail(401,'ONPREM_ACCESS_CHANGED');
  const roles=u.roles.map(r=>r.role).filter(r=>r.active),permissions=new Set(roles.flatMap(r=>r.permissions.map(p=>p.permission.code)));
  if(!roles.some(r=>r.code==='ADMIN')||!['SETUP_MANAGE','USER_MANAGE','ROLE_MANAGE'].every(p=>permissions.has(p as any)))return fail(403,'ONPREM_CURRENT_ADMIN_REQUIRED');
  // PasswordService accepts legacy hashes. Bound the exact locally-owned format
  // before invoking scrypt so a malformed row cannot dictate arbitrary work.
  if(!/^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(u.passwordHash))return fail(503,'ONPREM_PASSWORD_HASH_UNAVAILABLE');
  const stamp=hash(JSON.stringify([u.id,u.authVersion,u.passwordHash,roles.map(r=>[r.code,r.permissions.map(p=>p.permission.code).sort()]).sort()]));
  return {id:u.id,authVersion:u.authVersion,passwordHash:u.passwordHash,stamp};
 }
 private cleanup(){
  const now=this.now();for(const [id,s]of this.#sessions)if(s.expiresAt<=now)this.#sessions.delete(id);
 }
 private cookie(req:OnpremRequest,optional=false){
  const h=req.headers.cookie,values=typeof h==='string'?h.split(';').map(x=>x.trim()).filter(x=>x.startsWith(onpremSessionCookie+'=')):[];
  if(!values.length&&optional)return null;
  if(values.length!==1)return fail(401,'ONPREM_SESSION_REQUIRED');
  const value=values[0].slice(onpremSessionCookie.length+1);
  if(!/^[A-Za-z0-9_-]{43}$/.test(value))return fail(401,'ONPREM_SESSION_REQUIRED');
  return hash(value);
 }
 private same(s:Session,c:AccessTokenClaims,origin:string){
  if(s.userId!==c.sub||s.authVersion!==c.authVersion||s.browserSessionId!==c.browserSessionId||s.origin!==origin)return fail(401,'ONPREM_SESSION_BINDING_CHANGED');
 }
 private csrf(req:OnpremRequest,s:Session){
  const value=req.headers['x-factuez-csrf'];
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value)||!timingSafeEqual(Buffer.from(value),Buffer.from(s.csrf)))return fail(403,'ONPREM_CSRF_REQUIRED');
 }
 private async quota(subject:string,kind:string,windowMs:number,limit:number){
  if(!await this.deps.store.rate(hash('onprem:'+kind+':'+subject),Math.floor(this.now()/windowMs),limit))return fail(429,'ONPREM_RATE_LIMITED');
 }
 private async audit(userId:string,version:number,outcome:string){
  await this.deps.store.transaction(tx=>tx.audit({id:randomUUID(),requestId:randomUUID(),clientId:null,actorId:userId,
   action:'ONPREM_PASSWORD_STEP_UP',outcome,revision:version,peerHash:hash('onprem-browser-step-up'),at:new Date(this.now()).toISOString()}));
 }
 async status(req:OnpremRequest){
  this.cleanup();const {claims:c,live,origin}=await this.actor(req),id=this.cookie(req,true);
  let s=id?this.#sessions.get(id):undefined;
  if(s){this.same(s,c,origin);if(s.stamp&&s.stamp!==live.stamp){this.#sessions.delete(s.id);return fail(401,'ONPREM_ACCESS_CHANGED');}}
  let cookie:string|undefined;
  if(!s){
   await this.quota(c.sub,'session',60000,20);if(this.#sessions.size>=256)return fail(429,'ONPREM_SESSION_CAPACITY');
   cookie=randomBytes(32).toString('base64url');
   s={id:hash(cookie),userId:c.sub,authVersion:c.authVersion,browserSessionId:c.browserSessionId!,origin,
    csrf:randomBytes(32).toString('base64url'),expiresAt:this.now()+TTL,verifiedUntil:0,stamp:null};
   this.#sessions.set(s.id,s);
  }
  return {cookie,state:{profile:'ONPREM' as const,enabled:true,environment:'BETA' as const,authenticated:s.verifiedUntil>this.now(),
   csrfToken:s.csrf,expiresAt:new Date(s.expiresAt).toISOString(),serviceOnly:true,readonly:true}};
 }
 private async session(req:OnpremRequest,verified:boolean){
  this.cleanup();const {claims,live,origin}=await this.actor(req),id=this.cookie(req)!;
  const s=this.#sessions.get(id);if(!s)return fail(401,'ONPREM_SESSION_REQUIRED');
  this.same(s,claims,origin);this.csrf(req,s);
  if(s.stamp&&s.stamp!==live.stamp){this.#sessions.delete(id);return fail(401,'ONPREM_ACCESS_CHANGED');}
  if(verified&&(!s.stamp||s.verifiedUntil<=this.now()))return fail(403,'ONPREM_PASSWORD_REAUTH_REQUIRED');
  return {session:s,claims,live};
 }
 async reauthenticate(req:OnpremRequest,body:unknown){
  if(!plain(body)||Object.keys(body).join(',')!=='password'||typeof body.password!=='string'||!body.password||body.password.length>256)return fail(400,'ONPREM_PASSWORD_REQUIRED');
  const {session:s,claims:c,live:before}=await this.session(req,false);
  // A failed repeat reauth invalidates the old proof too.
  s.verifiedUntil=0;s.stamp=null;
  await this.quota(c.sub,'reauth-minute',60000,5);await this.quota(c.sub,'reauth-hour',3600000,20);
  if(this.#reauthUsers.size>=4||this.#reauthUsers.has(c.sub))return fail(429,'ONPREM_REAUTH_BUSY');
  this.#reauthUsers.add(c.sub);
  try{
   const correct=await this.deps.passwords.verify(body.password,before.passwordHash);
   if(!correct){await this.audit(c.sub,c.authVersion,'INVALID_PASSWORD');return fail(403,'ONPREM_PASSWORD_REAUTH_FAILED');}
   const after=await this.session(req,false);
   if(after.live.stamp!==before.stamp||after.session!==s)return fail(401,'ONPREM_ACCESS_CHANGED');
   await this.audit(c.sub,c.authVersion,'VERIFIED');
   // Audit persistence and another fresh auth/DB check precede the proof.
   const final=await this.session(req,false);
   if(final.live.stamp!==before.stamp||final.session!==s)return fail(401,'ONPREM_ACCESS_CHANGED');
   s.stamp=before.stamp;s.verifiedUntil=Math.min(s.expiresAt,this.now()+TTL);
   return {profile:'ONPREM' as const,authenticated:true,expiresAt:new Date(s.verifiedUntil).toISOString()};
  }finally{this.#reauthUsers.delete(c.sub);}
 }
 async execute<T>(req:OnpremRequest,work:(proof:string)=>Promise<T>):Promise<T>{
  const {session:s}=await this.session(req,true),proof=randomBytes(32).toString('base64url');
  return this.#context.run({request:req,sessionId:s.id,proof},()=>work(proof));
 }
 async verify(proof:string){
  const frame=this.#context.getStore();
  if(!frame||proof!==frame.proof)return fail(403,'ONPREM_PASSWORD_REAUTH_REQUIRED');
  const {session,claims}=await this.session(frame.request,true);
  if(session.id!==frame.sessionId)return fail(403,'ONPREM_SESSION_REQUIRED');
  // This result comes exclusively from a live owner record created after exact
  // PasswordService.verify success; no browser/claim can supply the boolean.
  return {id:claims.sub,stepUpVerified:true as const};
 }
 async logout(req:OnpremRequest){
  const {session}=await this.session(req,false);this.#sessions.delete(session.id);
  return {profile:'ONPREM' as const,loggedOut:true};
 }
 close(){this.#closed=true;this.#sessions.clear();this.#context.disable();}
 toJSON(){return {authority:'OnpremVerifiedAdmin',sessions:'PRIVATE',passwords:'IDENTITY_OWNED'};}
}
