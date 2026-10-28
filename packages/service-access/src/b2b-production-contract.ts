import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export const productionScopes = ['production:documents:read','production:documents:issue:01','production:documents:issue:03','production:notes:issue:07','production:notes:issue:08','production:guides:issue:09','production:guides:issue:31','production:webhooks:manage','production:masters:read','production:masters:write','production:users:read','production:users:write'] as const;
export type ProductionScope = typeof productionScopes[number];
export interface ProductionBinding { ruc:string; branchId:string; pointId:string; series:string }
export interface ProductionGrant { scope:ProductionScope; binding:ProductionBinding }
export interface ProductionActor { kind:'SERVICE'; environment:'PRODUCTION'; clientId:string; revision:number; tokenHash:string; expiresAt:number; grants:ProductionGrant[] }
export class ProductionError extends Error { constructor(readonly status:number,readonly code:string){super(code);} }
export function deny(status:number,code:string):never{throw new ProductionError(status,code);}
export const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function canonical(v:unknown):string { if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}'; }
export function binding(v:unknown):ProductionBinding { const b=v as ProductionBinding;
 if(!b||Object.keys(b).sort().join(',')!=='branchId,pointId,ruc,series'||(typeof b.ruc!=='string'||!/^\d{11}$/.test(b.ruc))||![b.branchId,b.pointId].every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x))||typeof b.series!=='string'||!/^[A-Z0-9]{4}$/.test(b.series))deny(400,'INVALID_BINDING');return structuredClone(b); }
export function grants(v:unknown):ProductionGrant[]{if(!Array.isArray(v)||!v.length||v.length>500)deny(400,'INVALID_GRANTS');const out=v.map(g=>{if(!g||Object.keys(g).sort().join(',')!=='binding,scope'||!productionScopes.includes(g.scope))deny(400,'INVALID_SCOPE');return {scope:g.scope,binding:binding(g.binding)};});if(new Set(out.map(canonical)).size!==out.length)deny(400,'DUPLICATE_GRANT');return out;}
export function authorize(a:ProductionActor,s:ProductionScope,b:ProductionBinding){binding(b);if(a.kind!=='SERVICE'||a.environment!=='PRODUCTION'||a.expiresAt<=Date.now()||!a.grants.some(g=>g.scope===s&&canonical(g.binding)===canonical(b)))deny(403,'INSUFFICIENT_SCOPE');}
export interface ProductionSql { query(text:string,values?:unknown[]):Promise<{rows:any[]}> }
export interface ProductionPool { connect():Promise<ProductionSql & {release():void}> }
export interface ProductionTx { get<T>(namespace:string,id:string):Promise<T|null>; put(namespace:string,id:string,value:unknown):Promise<void>; list<T>(namespace:string):Promise<Array<{id:string;value:T}>> }
export interface ProductionStore { transaction<T>(keys:string[],work:(tx:ProductionTx)=>Promise<T>):Promise<T> }
/** No in-memory production fallback. The installer applies production-schema.sql first. */
export class ProductionPostgresStore implements ProductionStore {
 constructor(private readonly pool:ProductionPool){}
 async transaction<T>(keys:string[],work:(tx:ProductionTx)=>Promise<T>){const db=await this.pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='15s'");for(const k of [...new Set(keys)].sort())await db.query('SELECT pg_advisory_xact_lock(731019,hashtext($1))',[k]);
 const tx:ProductionTx={get:async<T>(n:string,id:string)=>{const r=await db.query('SELECT value FROM b2b_production_record WHERE namespace=$1 AND id=$2',[n,id]);return r.rows[0]?.value as T??null;},put:async(n,id,v)=>{await db.query('INSERT INTO b2b_production_record(namespace,id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()',[n,id,JSON.stringify(v)]);},list:async<T>(n:string)=>{const r=await db.query('SELECT id,value FROM b2b_production_record WHERE namespace=$1 ORDER BY id',[n]);return r.rows as Array<{id:string;value:T}>;}};
 const result=await work(tx);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}}
}
export interface ProductionIntrospection { introspect(token:string):Promise<ProductionActor> }
export interface ProductionAttestation { version:1; keyId:string; tokenHash:string; clientId:string; revision:number; environment:'PRODUCTION'; kind:'SERVICE'; method:string; path:string; bodyHash:string; operationId:string; scope:ProductionScope; binding:ProductionBinding; issuedAt:number; expiresAt:number; nonce:string }
export function signAttestation(value:ProductionAttestation,key:Buffer){if(key.length<32)throw Error('ATTESTATION_KEY_REQUIRED');const payload=Buffer.from(canonical(value)).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');}
/** Native guard calls over an authenticated private mTLS peer. Never use forwarded peer headers. */
export async function verifyProductionAttestation(input:{attestation:string;token:string;method:string;path:string;body:unknown;operationId:string;scope:ProductionScope;binding:ProductionBinding;privatePeerVerified:boolean},keys:ReadonlyMap<string,Buffer>,identity:ProductionIntrospection,store:ProductionStore){
 if(!input.privatePeerVerified)deny(403,'PRIVATE_PEER_REQUIRED');if(typeof input.attestation!=='string'||input.attestation.length>16000)deny(401,'INVALID_ATTESTATION');const [p,s,...extra]=input.attestation.split('.');let v:ProductionAttestation;try{v=JSON.parse(Buffer.from(p,'base64url').toString());}catch{ return deny(401,'INVALID_ATTESTATION'); }
 if(!v||typeof v!=='object')deny(401,'INVALID_ATTESTATION');const key=keys.get(v.keyId);if(!key||key.length<32||extra.length||!s||!equal(createHmac('sha256',key).update(p).digest('base64url'),s))deny(401,'INVALID_ATTESTATION');const now=Date.now();
 if(v.version!==1||v.kind!=='SERVICE'||v.environment!=='PRODUCTION'||!Number.isSafeInteger(v.issuedAt)||!Number.isSafeInteger(v.expiresAt)||v.issuedAt>now+5000||v.issuedAt<now-30000||v.expiresAt<=v.issuedAt||v.expiresAt<=now||v.expiresAt-v.issuedAt>30000||!/^[a-f0-9-]{36}$/.test(v.nonce)||v.operationId!==input.operationId||v.method!==input.method||v.path!==input.path||v.bodyHash!==hash(canonical(input.body))||v.tokenHash!==hash(input.token)||v.scope!==input.scope||canonical(v.binding)!==canonical(input.binding))deny(401,'INVALID_ATTESTATION');
 const actor=await identity.introspect(input.token);authorize(actor,input.scope,input.binding);if(actor.tokenHash!==v.tokenHash||actor.clientId!==v.clientId||actor.revision!==v.revision||v.expiresAt>actor.expiresAt)deny(401,'STALE_ATTESTATION');
 await store.transaction(['nonce:'+v.nonce],async tx=>{if(await tx.get('nonce',v.nonce))deny(409,'ATTESTATION_REPLAY');await tx.put('nonce',v.nonce,{expiresAt:v.expiresAt});});return actor;
}


