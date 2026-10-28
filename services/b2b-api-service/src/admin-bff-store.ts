import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {inspect} from 'node:util';
import type {AdminSsoProfile} from './admin-bff-oidc';

export interface AdminLoginFlow {browserHash:string;nonce:string;verifier:string;expiresAt:number}
export interface AdminBrowserSession {accessToken:string;profile:AdminSsoProfile;csrfToken:string;expiresAt:number;revision:string}
export interface AdminBffStore {
 putFlow(state:string,value:AdminLoginFlow):Promise<void>;
 takeFlow(state:string,browserCookie:string):Promise<AdminLoginFlow|null>;
 putSession(id:string,value:AdminBrowserSession):Promise<void>;
 getSession(id:string):Promise<AdminBrowserSession|null>;
 deleteSession(id:string):Promise<void>;
 admit(key:string,limit:number,ttlMs:number):Promise<boolean>;
}
/** Explicit configured Redis client; no environment lookup or in-memory fallback. */
export interface AdminBffRedis {
 get(key:string):Promise<string|null>;
 set(key:string,value:string,px:'PX',ttl:number,nx:'NX'):Promise<string|null>;
 del(key:string):Promise<number>;
 eval(script:string,keyCount:number,...args:string[]):Promise<unknown>;
}
export const adminBffHash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const adminBffOpaque=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s);
export function adminBffSame(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
const consume="if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const quota="local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; if n>tonumber(ARGV[2]) then return 0 else return 1 end";
export class RedisAdminBffStore implements AdminBffStore {
 #key:Buffer;#prefix:string;
 constructor(private readonly redis:AdminBffRedis,key:Buffer,deploymentId:string,private readonly now=Date.now){
  if(!Buffer.isBuffer(key)||key.length!==32||!/^[-a-z0-9]{1,40}$/.test(deploymentId)||!redis||!['get','set','del','eval'].every(k=>typeof (redis as any)[k]==='function'))throw new Error('EXPLICIT_ADMIN_BFF_STORE_REQUIRED');
  this.#key=Buffer.from(key);this.#prefix='factuez:admin-bff:'+deploymentId+':';
 }
 toJSON(){return {store:'RedisAdminBffStore',credentials:'PRIVATE'};}
 [inspect.custom](){return 'RedisAdminBffStore { credentials: [PRIVATE] }';}
 private name(kind:string,id:string){if(!adminBffOpaque(id))throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');return this.#prefix+kind+':'+adminBffHash(id);}
 private seal(name:string,value:unknown){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(Buffer.from(name));const plain=Buffer.from(JSON.stringify(value));try{const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');}finally{plain.fill(0);}}
 private open<T>(name:string,raw:string):T{
  if(typeof raw!=='string'||raw.length>32768)throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');
  const p=raw.split('.');if(p.length!==4||p[0]!=='v1'||p.slice(1).some(s=>!s||!/^[A-Za-z0-9_-]+$/.test(s)))throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');
  const iv=Buffer.from(p[1],'base64url'),tag=Buffer.from(p[2],'base64url');if(iv.length!==12||tag.length!==16)throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');
  const cipher=createDecipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(Buffer.from(name));cipher.setAuthTag(tag);const plain=Buffer.concat([cipher.update(Buffer.from(p[3],'base64url')),cipher.final()]);try{return JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);}
 }
 private ttl(expiresAt:number,max:number){const ttl=expiresAt-this.now();if(!Number.isSafeInteger(ttl)||ttl<1||ttl>max)throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');return ttl;}
 async putFlow(state:string,value:AdminLoginFlow){const name=this.name('flow',state);if(await this.redis.set(name,this.seal(name,value),'PX',this.ttl(value.expiresAt,120000),'NX')!=='OK')throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');}
 async takeFlow(state:string,browserCookie:string){
  const name=this.name('flow',state),raw=await this.redis.get(name);if(raw===null)return null;const v=this.open<AdminLoginFlow>(name,raw);
  if(Object.keys(v).sort().join(',')!=='browserHash,expiresAt,nonce,verifier'||!adminBffOpaque(v.nonce)||!adminBffOpaque(v.verifier)||!adminBffSame(v.browserHash,adminBffHash(browserCookie))||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=this.now())return null;
  return Number(await this.redis.eval(consume,1,name,raw))===1?v:null;
 }
 async putSession(id:string,value:AdminBrowserSession){const name=this.name('session',id);if(await this.redis.set(name,this.seal(name,value),'PX',this.ttl(value.expiresAt,300000),'NX')!=='OK')throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');}
 async getSession(id:string){const name=this.name('session',id),raw=await this.redis.get(name);if(raw===null)return null;const v=this.open<AdminBrowserSession>(name,raw);
  if(Object.keys(v).sort().join(',')!=='accessToken,csrfToken,expiresAt,profile,revision'||!adminBffOpaque(v.csrfToken)||!adminBffOpaque(v.revision)||typeof v.accessToken!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(v.accessToken)||!Number.isSafeInteger(v.expiresAt))throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');
  if(v.expiresAt<=this.now()){await this.redis.del(name);return null;}return v;
 }
 async deleteSession(id:string){await this.redis.del(this.name('session',id));}
 async admit(key:string,limit:number,ttlMs:number){if(!/^[a-f0-9]{64}$/.test(key)||!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>60000)throw new Error('ADMIN_BFF_STORE_UNAVAILABLE');return Number(await this.redis.eval(quota,1,this.#prefix+'rate:'+key,String(ttlMs),String(limit)))===1;}
}
