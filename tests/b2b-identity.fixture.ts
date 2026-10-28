// Test-only storage/keys. No production memory fallback or customer credentials.
import { generateKeyPairSync,randomBytes,randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { B2bIdentity } from '../services/identity-service/src/b2b/service';
import { B2bTokenCodec } from '../services/identity-service/src/b2b/token';
import { fail,type Client,type Store,type Transaction,type Audit,type DelegationVerifier } from '../services/identity-service/src/b2b/model';
const pair=()=>generateKeyPairSync('rsa',{modulusLength:2048});
const key=pair(),other=pair();
export const pem=Buffer.from(key.privateKey.export({type:'pkcs8',format:'pem'}));
export const others={human:Buffer.from(other.publicKey.export({type:'spki',format:'pem'})),integration:Buffer.from(other.publicKey.export({type:'spki',format:'pem'})),tls:Buffer.from(other.publicKey.export({type:'spki',format:'pem'}))};
export const id=(n:number)=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000001`;
export const binding={issuerId:1,issuerRuc:'00000000001',environment:'BETA' as const,branchId:id(1),pointId:id(2),seriesId:id(3),documentType:'01' as const};
export const ctx=()=>({requestId:randomUUID(),peer:'synthetic-local-peer'});
export const input=()=>({label:'Synthetic B2B application',kind:'SERVICE',scopes:['b2b:context:read','b2b:catalog:read'],bindings:[structuredClone(binding)]});
export const basic=(id:string,secret:string)=>'Basic '+Buffer.from(id+':'+secret).toString('base64');
export class MemoryB2bStore implements Store {
  clients=new Map<string,Client>();audits:Audit[]=[];down=false;failAudit=false;limited=false;
  private tail:Promise<unknown>=Promise.resolve();
  async rate(){if(this.down)throw new Error('DB down');return !this.limited;}
  transaction<T>(work:(tx:Transaction)=>Promise<T>):Promise<T>{
    const task=this.tail.then(async()=>{
      if(this.down)throw new Error('DB down');
      const clients=structuredClone(this.clients),audits=structuredClone(this.audits);
      const tx:Transaction={get:async id=>structuredClone(clients.get(id)??null),create:async row=>{if(clients.has(row.id))throw new Error();clients.set(row.id,structuredClone(row));},
        save:async(row,revision)=>{if(clients.get(row.id)?.revision!==revision)return fail(409,'REVISION_CONFLICT');clients.set(row.id,structuredClone(row));},
        audit:async event=>{if(this.failAudit)throw new Error('Audit down');audits.push(event);}};
      const result=await work(tx);this.clients=clients;this.audits=audits;return result;
    });this.tail=task.catch(()=>{});return task;
  }
}
export function fixture(delegation:DelegationVerifier|null=null,enabledScopes?:readonly import('../packages/contracts/src/b2b-security').B2bIdentityScope[]){
  let time=1800000000000;
  const store=new MemoryB2bStore(),admin={verify:vi.fn(async(token:string)=>{if(token!=='human-step-up')return fail(403,'STEP_UP_REQUIRED');return {id:id(9),stepUpVerified:true as const};})};
  const catalogue={validate:vi.fn(async()=>{})};
  const codec=new B2bTokenCodec(pem,'https://b2b.identity.invalid',()=>Math.floor(time/1000),others);
  const core=new B2bIdentity(store,codec,randomBytes(32),admin,catalogue,delegation,()=>time,enabledScopes);
  return {core,store,admin,catalogue,codec,advance:(ms:number)=>{time+=ms;},now:()=>Math.floor(time/1000)};
}
export async function issued(f=fixture()){
  const made=await f.core.create('human-step-up',input(),ctx());
  const token=await f.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read b2b:catalog:read'},ctx());
  return {...f,made,token:token.access_token!};
}
