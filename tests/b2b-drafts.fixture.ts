import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { B2bEnabledIdentityScopes,B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { B2bDrafts } from '../services/billing-service/src/b2b/drafts';
import type { Draft,DraftOperation,DraftStore,DraftTransaction } from '../services/billing-service/src/b2b/draft-model';
import { fixture,basic,ctx } from './b2b-identity.fixture';
import { invoiceBinding } from './b2b-read.fixture';
export class MemoryDraftStore implements DraftStore {
  rows=new Map<string,Draft>();operations=new Map<string,DraftOperation>();failAppend=false;
  issuance=false;fiscal={nextNumber:1,documents:[] as any[]};
  private tail:Promise<unknown>=Promise.resolve();
  transaction<T>(_scope:string,work:(tx:DraftTransaction)=>Promise<T>):Promise<T>{
    const pending=this.tail.then(async()=>{const rows=structuredClone(this.rows),ops=structuredClone(this.operations),fiscal=structuredClone(this.fiscal);
      const tx:DraftTransaction={get:async id=>structuredClone(rows.get(id)??null),
        create:async d=>{if([...rows.values()].some(old=>old.clientId===d.clientId&&old.actorKey===d.actorKey&&old.binding.issuerId===d.binding.issuerId&&JSON.stringify(old.body.externalReference)===JSON.stringify(d.body.externalReference)))throw new B2bSecurityError(409,'DRAFT_REFERENCE_CONFLICT');rows.set(d.id,structuredClone(d));},
        save:async(d,expected)=>{if(rows.get(d.id)?.revision!==expected)throw new B2bSecurityError(412,'REVISION_CONFLICT');rows.set(d.id,structuredClone(d));},
        prior:async(c,a,k)=>structuredClone([...ops.values()].find(op=>op.clientId===c&&op.actorKey===a&&op.keyHash===k)??null),
        operation:async(id,c,a)=>{const op=ops.get(id);return op?.clientId===c&&op.actorKey===a?structuredClone(op):null;},
        append:async op=>{if(this.failAppend)throw new Error('durable audit unavailable');ops.set(op.id,structuredClone(op));}};
      if(this.issuance)tx.issue=async(d,op)=>{const result={documentId:randomUUID(),series:d.binding.documentType==='01'?'F001':'B001',number:String(fiscal.nextNumber++),fullNumber:''};result.fullNumber=result.series+'-'+result.number;fiscal.documents.push({...result,actor:op.actor});return result;};
      const result=await work(tx);this.rows=rows;this.operations=ops;this.fiscal=fiscal;return result;
    });this.tail=pending.catch(()=>{});return pending;
  }
}
export const draftInput=()=>({issuerId:1,branchId:invoiceBinding.branchId,pointId:invoiceBinding.pointId,seriesId:invoiceBinding.seriesId,environment:'BETA' as const,documentType:'01' as const,currency:'PEN' as const,paymentTerms:'CONTADO' as const,
  externalReference:{namespace:'erp_ficticio',value:'venta_ficticia_01'},issueDate:'2026-10-20',customer:{identityType:'6' as const,identityNumber:'20444444444',legalName:'CLIENTE FICTICIO'},
  lines:[{productCode:'FICTICIO-1',description:'Ítem sintético',unitCode:'NIU',quantity:'1',unitPriceWithTax:'118',taxAffectationCode:'10' as const,igvRate:'18' as const}]});
export async function draftFixture(issuance=false){
  const auth=fixture(null,B2bEnabledIdentityScopes),scopes=['b2b:context:read','b2b:drafts:write','b2b:operations:read',...(issuance?['b2b:documents:issue']:[])];
  const made=await auth.core.create('human-step-up',{label:'Synthetic draft client',kind:'SERVICE',scopes,bindings:[invoiceBinding]},ctx());
  const token=(await auth.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:scopes.join(' ')},ctx())).access_token!;
  const identity={authenticate:vi.fn((t:string,s:any[],k:'SERVICE'|'USER')=>auth.core.authenticate(t,s,ctx(),k))},store=new MemoryDraftStore();
  store.issuance=issuance;
  const context={resolve:vi.fn(async()=>({binding:invoiceBinding}))},core=new B2bDrafts(store,identity,context,()=>auth.now()*1000);
  return {auth,made,token,identity,store,context,core};
}
