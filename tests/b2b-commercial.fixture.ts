import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {B2bEnabledIdentityScopes,B2bSecurityError,b2bBindingsContain} from '../packages/contracts/src/b2b-security';
import {B2bCommercial} from '../services/billing-service/src/b2b/commercial';
import type {CommercialResource,CommercialOperation,CommercialStore,CommercialTransaction,OriginalReference,CreditObservation} from '../services/billing-service/src/b2b/commercial-model';
import {fixture,basic,ctx} from './b2b-identity.fixture';
import {invoiceBinding} from './b2b-read.fixture';
import {draftInput} from './b2b-drafts.fixture';
export class MemoryCommercialStore implements CommercialStore {
  rows=new Map<string,CommercialResource>();ops=new Map<string,CommercialOperation>();numbers=new Map<string,number>();
  originals=new Map<string,OriginalReference>();documents:any[]=[];nextFiscal=1;failAppend=false;conversion=true;
  credits:CreditObservation[]=[];
  private tail:Promise<unknown>=Promise.resolve();
  transaction<T>(_scope:string,work:(tx:CommercialTransaction)=>Promise<T>):Promise<T>{
    const pending=this.tail.then(async()=>{
      const rows=structuredClone(this.rows),ops=structuredClone(this.ops),numbers=structuredClone(this.numbers),documents=structuredClone(this.documents);let nextFiscal=this.nextFiscal;
      const tx:CommercialTransaction={
        get:async id=>structuredClone(rows.get(id)??null),
        list:async(c,a,k,b,l,after)=>[...rows.values()].filter(r=>r.clientId===c&&r.actorKey===a&&r.kind===k&&(!after||r.id>after)&&b2bBindingsContain(b,r.binding)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,l).map(r=>structuredClone(r)),
        create:async r=>{if([...rows.values()].some(x=>x.clientId===r.clientId&&x.kind===r.kind&&x.binding.issuerId===r.binding.issuerId&&JSON.stringify(x.body.externalReference)===JSON.stringify(r.body.externalReference)))throw new B2bSecurityError(409,'COMMERCIAL_REFERENCE_CONFLICT');rows.set(r.id,structuredClone(r));},
        save:async(r,expected)=>{if(rows.get(r.id)?.revision!==expected)throw new B2bSecurityError(412,'REVISION_CONFLICT');rows.set(r.id,structuredClone(r));},
        nextNumber:async b=>{const key=b.issuerId+':'+b.pointId,n=numbers.get(key)??1;if(n>99999999)throw new B2bSecurityError(409,'COMMERCIAL_SERIES_EXHAUSTED');numbers.set(key,n+1);return 'NV-'+String(n).padStart(8,'0');},
        prior:async(c,a,k)=>structuredClone([...ops.values()].find(o=>o.clientId===c&&o.actorKey===a&&o.keyHash===k)??null),
        operation:async(id,c,a)=>{const o=ops.get(id);return o?.clientId===c&&o.actorKey===a?structuredClone(o):null;},
        append:async op=>{if(this.failAppend)throw new Error('SYNTHETIC_AUDIT_FAILURE');ops.set(op.id,structuredClone(op));},
        original:async id=>structuredClone(this.originals.get(id)??null),
        observedCredits:async()=>structuredClone(this.credits),
      };
      if(this.conversion)tx.convert=async(r,op)=>{const series=r.binding.documentType==='01'?'F001':'B001',number=String(nextFiscal++),result={documentId:randomUUID(),series,number,fullNumber:series+'-'+number};documents.push({...result,actor:op.actor});return result;};
      const result=await work(tx);this.rows=rows;this.ops=ops;this.numbers=numbers;this.documents=documents;this.nextFiscal=nextFiscal;return result;
    });this.tail=pending.catch(()=>{});return pending;
  }
}
export const commercialInput=(value='synthetic-note')=>({conversion:{...draftInput(),externalReference:{namespace:'synthetic',value}}});
export async function commercialFixture(conversion=true){
  const auth=fixture(null,B2bEnabledIdentityScopes),scopes=['b2b:context:read','b2b:documents:read','b2b:documents:issue','b2b:operations:read','b2b:sales-notes:read','b2b:sales-notes:write','b2b:corrections:read','b2b:corrections:write'];
  const made=await auth.core.create('human-step-up',{label:'Synthetic commercial client',kind:'SERVICE',scopes,bindings:[invoiceBinding]},ctx());
  const token=(await auth.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:scopes.join(' ')},ctx())).access_token!;
  const identity={authenticate:vi.fn((t:string,s:any[],k:'SERVICE'|'USER')=>auth.core.authenticate(t,s,ctx(),k))},store=new MemoryCommercialStore(),context={resolve:vi.fn(async()=>({binding:invoiceBinding}))};store.conversion=conversion;
  const core=new B2bCommercial(store,identity,context,conversion,()=>auth.now()*1000);
  const command=(action:any,id:string|null,key:string,etag?:string,body:any={},kind:any='SALES_NOTE')=>core.command(token,'SERVICE',kind,action,1,id,key,etag,body);
  const original:OriginalReference={id:randomUUID(),binding:invoiceBinding,currency:'PEN',payableAmount:'118.00',snapshotSha256:'a'.repeat(64),fullNumber:'F001-1'};store.originals.set(original.id,original);
  return {auth,made,token,identity,store,context,core,command,original};
}
