import { createHash, randomUUID } from 'node:crypto';
import { IntegrationContractVersion, integrationGrantAllows, type IntegrationChangeV1, type IntegrationChangePageV1,
  type IntegrationDocumentDetailV1, type IntegrationDocumentFiltersV1, type IntegrationBatchV1 } from '@factuez/contracts/integration';
import { deny, plain, ruc, uuid, requireIssuer, requireScopes, snapshotHash, IntegrationReadError,
  type ReadIdentity, type ReadPrincipal, type BillingReadEnvelope } from '@factuez/service-access/dist/integration';
import { changeQuery } from '@factuez/service-access/dist/integration-change-query';
import type { JournalPage, JournalPosition, JournalEvent } from '@factuez/service-access/dist/integration-journal';
import { ExportVault } from './vault';
import type { OwnerHttp, Binding } from './model';
import type { ChangeDeliveryStore, ChangeDeliveryRecord } from './change-store';

const scopes=['integration:documents:read','integration:changes:read'] as const;
const checkpointAad='factuez.changes.checkpoint.v1';
export const ChangeLimits={ttlMs:7*86400000,scanEvents:500,expandedMembers:2000,payloadBytes:4*1024*1024} as const;
type Source='BILLING'|'SUNAT';
interface Checkpoint {
  v:'factuez.changes.v1';id:string;clientId:string;context:string;filters:IntegrationDocumentFiltersV1;
  expires:number;positions:Record<Source,JournalPosition>;ordinal:string;turn:Source;
  pending:{key:string;offset:number}|null;
}
interface FrozenQueue {items:IntegrationChangeV1[];bindings:Binding[];batches:{id:string;identity:string}[]}
interface Delivery extends FrozenQueue {page:IntegrationChangePageV1}
const sourceNames:Source[]=['BILLING','SUNAT'];
const sequence=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
const binding=(d:IntegrationDocumentDetailV1):Binding=>({id:d.id,branchId:d.branchId,pointId:d.pointId,seriesCounterId:d.seriesCounterId,type:d.type,snapshotSha256:d.snapshotSha256});
const batchIdentity=(b:IntegrationBatchV1)=>snapshotHash({id:b.id,issuerRuc:b.issuerRuc,environment:b.environment,kind:b.kind,
  identifier:b.identifier,membersComplete:b.membersComplete,members:b.members.map(({documentVersion,...v})=>v)});
const eventId=(source:Source,id:string,doc:string)=>{
  const hex=createHash('sha256').update(`factuez.change.v1:${source}:${id}:${doc}`).digest('hex').slice(0,32).split('');
  hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);const v=hex.join('');
  return `${v.slice(0,8)}-${v.slice(8,12)}-${v.slice(12,16)}-${v.slice(16,20)}-${v.slice(20)}`;
};
/** Durable deliveries, not Socket.io/polling updatedAt. Owners retain all source data and journals. */
export class IntegrationChanges {
  private active=0;
  constructor(private readonly store:ChangeDeliveryStore,private readonly vault:ExportVault,private readonly identity:ReadIdentity,
    private readonly billing:OwnerHttp,private readonly sunat:OwnerHttp,private readonly now=Date.now) {}
  private owner(source:Source) {return source==='BILLING'?this.billing:this.sunat;}
  private async principal(token:string,issuerRuc:string) {
    const p=await this.identity.authenticate(token,[...scopes]);requireScopes(p,[...scopes]);requireIssuer(p,issuerRuc);return p;
  }
  private async journal(token:string,issuerRuc:string,source:Source,after:JournalPosition|null,limit=1):Promise<JournalPage> {
    const q=new URLSearchParams({issuerRuc,...(after?{epoch:after.epoch,after:after.sequence}:{}),limit:String(limit)});
    const page=await this.owner(source).json<JournalPage>(`/internal/integration/journal?${q}`,token);
    if(!plain(page)||!uuid(page.epoch)||!sequence(page.head)||!sequence(page.floor)||!plain(page.position)||page.position.epoch!==page.epoch||!sequence(page.position.sequence)||
      BigInt(page.floor)>BigInt(page.head)||BigInt(page.position.sequence)>BigInt(page.head)||!Array.isArray(page.events)||page.events.length>limit)
      return deny(409,'EVIDENCE_INCONSISTENT');
    if(after && (page.epoch!==after.epoch||BigInt(after.sequence)<BigInt(page.floor)||BigInt(after.sequence)>BigInt(page.head))) return deny(410,'CURSOR_EXPIRED');
    let previous=after?.sequence??page.head;
    for(const e of page.events) {
      if(!plain(e)||typeof e.id!=='string'||!e.id.startsWith(source+':')||!uuid(e.id.slice(source.length+1))||!uuid(e.ownerId)||!sequence(e.sequence)||BigInt(e.sequence)<=BigInt(previous)||
        BigInt(e.sequence)>BigInt(page.head)||!['DOCUMENT','BATCH'].includes(e.ownerKind)||
        !['DOCUMENT_CREATED','DOCUMENT_STATE_CHANGED','ARTIFACT_ADDED','DOCUMENT_RECONCILED'].includes(e.kind)||
        !Number.isFinite(Date.parse(e.occurredAt))||!(e.artifactId===null||uuid(e.artifactId))) return deny(409,'EVIDENCE_INCONSISTENT');
      previous=e.sequence;
    }
    if(after && (BigInt(page.position.sequence)<BigInt(after.sequence)||page.position.sequence!==(page.events.at(-1)?.sequence??after.sequence)))
      return deny(409,'EVIDENCE_INCONSISTENT');
    return page;
  }
  /** SUNAT lower bound is deliberately obtained BEFORE the Billing MVCC cut. Overlap is safe; omission is not. */
  async beforeCapture(token:string,p:ReadPrincipal,issuerRuc:string) {
    if(!p.scopes.includes('integration:changes:read'))return null;
    await this.principal(token,issuerRuc);const page=await this.journal(token,issuerRuc,'SUNAT',null);
    return {epoch:page.epoch,sequence:page.head};
  }
  finishCapture(p:ReadPrincipal,filters:IntegrationDocumentFiltersV1,billing:JournalPosition|undefined,sunat:JournalPosition|null):string|null {
    if(sunat===null)return null;
    if(!billing||!uuid(billing.epoch)||!sequence(billing.sequence))return deny(503,'CHANGE_FEED_NOT_READY');
    const cp:Checkpoint={v:'factuez.changes.v1',id:randomUUID(),clientId:p.clientId,context:snapshotHash(p),
      filters:{...filters,limit:100,cursor:null},expires:this.now()+ChangeLimits.ttlMs,
      positions:{BILLING:billing,SUNAT:sunat},ordinal:'0',turn:'BILLING',pending:null};
    return this.encode(cp);
  }
  private encode(cp:Checkpoint) {const value=this.vault.sealJson(cp,checkpointAad).toString('base64url');
    if(value.length>4096)return deny(422,'EXPORT_TOO_LARGE');return value;}
  private decode(value:string):Checkpoint {
    let cp:Checkpoint;try{cp=this.vault.openJson(Buffer.from(value,'base64url'),checkpointAad);}catch{return deny(400,'INVALID_QUERY');}
    if(!plain(cp)||cp.v!=='factuez.changes.v1'||!uuid(cp.id)||!uuid(cp.clientId)||!/^([a-f0-9]{64})$/.test(cp.context)||
      !Number.isSafeInteger(cp.expires)||!sequence(cp.ordinal)||!sourceNames.includes(cp.turn)||!plain(cp.filters)||!ruc(cp.filters.issuerRuc)||
      cp.filters.environment!=='BETA'||cp.filters.dataset!=='ISSUED_BUSINESS'||!plain(cp.positions)||
      !sourceNames.every(s=>plain(cp.positions[s])&&uuid(cp.positions[s].epoch)&&sequence(cp.positions[s].sequence))||
      !(cp.pending===null||(plain(cp.pending)&&/^[a-f0-9]{64}$/.test(cp.pending.key)&&Number.isSafeInteger(cp.pending.offset)&&cp.pending.offset>=0)))
      return deny(400,'INVALID_QUERY');
    if(cp.expires<=this.now())return deny(410,'CURSOR_EXPIRED');return cp;
  }
  private aad(r:ChangeDeliveryRecord) {return `factuez.changes.delivery.v1:${r.id}:${r.clientId}:${r.contextSha256}:${r.checkpointKey}`;}
  private open(r:ChangeDeliveryRecord):Delivery {
    if(Date.parse(r.expiresAt)<=this.now())return deny(410,'CURSOR_EXPIRED');
    const data=this.vault.openJson<Delivery>(r.payload,this.aad(r));
    if(!plain(data)||!Array.isArray(data.items)||!Array.isArray(data.bindings)||!Array.isArray(data.batches)||!plain(data.page))return deny(409,'INTEGRITY_FAILED');
    return data;
  }
  private matches(d:IntegrationDocumentDetailV1,f:IntegrationDocumentFiltersV1) {
    return f.types.includes(d.type)&&d.issueDate>=f.from&&d.issueDate<=f.to&&
      (f.branchId===null||d.branchId===f.branchId)&&(f.pointId===null||d.pointId===f.pointId)&&
      (f.series===null||d.series===f.series)&&(f.currency===null||d.currency===f.currency)&&
      (f.fiscalStatus===null||f.fiscalStatus==='NOT_CHECKED');
  }
  private async expand(token:string,p:ReadPrincipal,cp:Checkpoint,source:Source,e:JournalEvent,deadline:number):Promise<FrozenQueue> {
    const queue:FrozenQueue={items:[],bindings:[],batches:[]};let ids:string[];
    if(e.ownerKind==='BATCH') {
      let b:IntegrationBatchV1;
      try{b=await this.sunat.json(`/internal/integration/batches/${e.ownerId}?issuerRuc=${cp.filters.issuerRuc}`,token);}
      catch(error){if(error instanceof IntegrationReadError&&error.status===404)return queue;throw error;}
      if(b.id!==e.ownerId||b.issuerRuc!==cp.filters.issuerRuc||b.environment!=='BETA'||!b.membersComplete||!Array.isArray(b.members)||!b.members.length||
        new Set(b.members.map(m=>m.documentId)).size!==b.members.length)return deny(409,'INCOMPLETE_BINDING');
      if(b.members.length>ChangeLimits.expandedMembers)return deny(422,'EXPORT_TOO_LARGE');
      ids=b.members.map(m=>m.documentId).sort();queue.batches.push({id:b.id,identity:batchIdentity(b)});
    }else ids=[e.ownerId];
    for(const id of ids) {
      if(this.now()>=deadline)return deny(503,'CONSISTENT_READ_UNAVAILABLE');
      let d:IntegrationDocumentDetailV1;
      try{d=(await this.billing.json<BillingReadEnvelope>(`/internal/integration/documents/${id}?issuerRuc=${cp.filters.issuerRuc}`,token)).document;}
      catch(error){if(error instanceof IntegrationReadError&&error.status===404&&e.ownerKind==='DOCUMENT')return queue;throw error;}
      if(d.id!==id||d.issuerRuc!==cp.filters.issuerRuc||!integrationGrantAllows(p.grants,d)||!['01','03','07','08'].includes(d.type)||
        !/^[a-f0-9]{64}$/.test(d.resourceVersion)||!d.snapshotSha256)return deny(409,'INCOMPLETE_BINDING');
      // All batch members must remain authorized, including those outside date/type filters.
      queue.bindings.push(binding(d));if(!this.matches(d,cp.filters))continue;
      const resource={issuerRuc:d.issuerRuc,environment:'BETA' as const,dataset:'ISSUED_BUSINESS' as const,
        type:d.type,branchId:d.branchId,pointId:d.pointId,seriesCounterId:d.seriesCounterId};
      queue.items.push({eventId:eventId(source,e.id,id),documentId:id,type:d.type,issuerRuc:d.issuerRuc,environment:'BETA',
        sequence:'0',kind:e.kind,occurredAt:e.occurredAt,version:d.resourceVersion,resource});
    }
    return queue;
  }
  private async authorized(token:string,p:ReadPrincipal,cp:Checkpoint,data:FrozenQueue) {
    if(cp.expires<=this.now())return deny(410,'CURSOR_EXPIRED');
    if(data.bindings.length) {
      const answer=await this.billing.json<{valid:true}>('/internal/integration/reauthorize',token,{issuerRuc:cp.filters.issuerRuc,bindings:data.bindings});
      if(answer.valid!==true)return deny(409,'INCOMPLETE_BINDING');
    }
    for(const b of data.batches) {
      const current=await this.sunat.json<IntegrationBatchV1>(`/internal/integration/batches/${b.id}?issuerRuc=${cp.filters.issuerRuc}`,token);
      if(batchIdentity(current)!==b.identity)return deny(409,'EVIDENCE_INCONSISTENT');
    }
    const final=await this.principal(token,cp.filters.issuerRuc);
    if(snapshotHash(final)!==snapshotHash(p)||snapshotHash(final)!==cp.context)return deny(401,'UNAUTHENTICATED');
    await Promise.all(sourceNames.map(s=>this.journal(token,cp.filters.issuerRuc,s,cp.positions[s])));
    if(cp.expires<=this.now())return deny(410,'CURSOR_EXPIRED');
  }
  async page(token:string,query:unknown):Promise<IntegrationChangePageV1> {
    // Remains bounded even if the HTTP client disconnects while owner work is in progress.
    if(this.active>=2)return deny(429,'RATE_LIMITED');this.active++;
    try{return await this.readPage(token,query);}finally{this.active--;}
  }
  private async readPage(token:string,query:unknown):Promise<IntegrationChangePageV1> {
    const q=changeQuery(query),p=await this.principal(token,q.issuerRuc),cp=this.decode(q.checkpoint);
    if(cp.clientId!==p.clientId)return deny(404,'RESOURCE_NOT_FOUND');
    if(cp.filters.issuerRuc!==q.issuerRuc||snapshotHash(p)!==cp.context)return deny(409,'CURSOR_CONTEXT_CHANGED');
    // Check BOTH source epochs/floors even on a durable cached retry. Never resurrect a retained-out feed.
    const heads=await Promise.all(sourceNames.map(s=>this.journal(token,q.issuerRuc,s,cp.positions[s])));
    const key=snapshotHash({cp,limit:q.limit});let record=await this.store.get(p.clientId,key);
    if(!record) {
      const next=structuredClone(cp);next.id=randomUUID();const queue:FrozenQueue={items:[],bindings:[],batches:[]};
      const merge=(v:FrozenQueue)=>{queue.items.push(...v.items);
        for(const b of v.bindings)if(!queue.bindings.some(x=>x.id===b.id))queue.bindings.push(b);
        for(const b of v.batches)if(!queue.batches.some(x=>x.id===b.id))queue.batches.push(b);};
      if(cp.pending) {
        const pending=await this.store.get(p.clientId,cp.pending.key);if(!pending)return deny(410,'CURSOR_EXPIRED');
        if(pending.contextSha256!==cp.context||pending.issuerRuc!==q.issuerRuc)return deny(409,'CURSOR_CONTEXT_CHANGED');
        const data=this.open(pending);if(cp.pending.offset>=data.items.length)return deny(409,'INTEGRITY_FAILED');
        merge({...data,items:data.items.slice(cp.pending.offset)});next.pending=null;
      }
      let scanned=0;const deadline=this.now()+18000;
      while(queue.items.length<q.limit&&scanned<ChangeLimits.scanEvents) {
        if(this.now()>=deadline)return deny(503,'CONSISTENT_READ_UNAVAILABLE');
        let found=false;
        for(let attempt=0;attempt<2;attempt++) {
          const source=next.turn,index=sourceNames.indexOf(source);next.turn=source==='BILLING'?'SUNAT':'BILLING';
          if(BigInt(next.positions[source].sequence)>=BigInt(heads[index].head))continue;
          const page=await this.journal(token,q.issuerRuc,source,next.positions[source]);
          const e=page.events[0];if(!e)return deny(409,'EVIDENCE_INCONSISTENT');
          merge(await this.expand(token,p,next,source,e,deadline));next.positions[source]={epoch:page.epoch,sequence:e.sequence};
          found=true;scanned++;break;
        }
        if(!found)break;
      }
      if(queue.bindings.length>10000||Buffer.byteLength(JSON.stringify(queue))>ChangeLimits.payloadBytes-16384)return deny(422,'EXPORT_TOO_LARGE');
      const items=queue.items.slice(0,q.limit).map(e=>({...e,sequence:(BigInt(cp.ordinal)+BigInt(queue.items.indexOf(e)+1)).toString()}));
      next.ordinal=(BigInt(cp.ordinal)+BigInt(items.length)).toString();
      if(queue.items.length>items.length)next.pending={key,offset:items.length};
      const hasMore=next.pending!==null||sourceNames.some((s,i)=>BigInt(next.positions[s].sequence)<BigInt(heads[i].head));
      const page:IntegrationChangePageV1={schemaVersion:IntegrationContractVersion,items,nextCheckpoint:this.encode(next),hasMore,
        expiresAt:new Date(cp.expires).toISOString()};
      await this.authorized(token,p,cp,queue);
      // Empty polling does not allocate a durable payload per poll. Its checkpoint still advances safely.
      if(!items.length) {
        await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:randomUUID(),operation:'CHANGES',sha256:null,byteLength:null});
        return page;
      }
      const candidate:ChangeDeliveryRecord={id:randomUUID(),clientId:p.clientId,contextSha256:cp.context,issuerRuc:q.issuerRuc,checkpointKey:key,
        createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(cp.expires).toISOString(),payload:Buffer.alloc(0)};
      candidate.payload=this.vault.sealJson({...queue,page},this.aad(candidate));record=await this.store.put(candidate);
    }
    if(record.clientId!==p.clientId||record.contextSha256!==cp.context||record.issuerRuc!==q.issuerRuc)return deny(409,'CURSOR_CONTEXT_CHANGED');
    const data=this.open(record);await this.authorized(token,p,cp,data);
    await this.store.audit({clientId:p.clientId,revision:p.revision,recordId:record.id,operation:'CHANGES',sha256:null,byteLength:null});return data.page;
  }
  async ready(token:string,issuerRuc:string):Promise<boolean> {
    const results=await Promise.all(sourceNames.map(s=>this.owner(s).json<{ready:boolean}>(`/internal/integration/change-ready?issuerRuc=${issuerRuc}`,token)));
    return results.every(v=>v.ready===true);
  }
  sweep() {return this.store.sweep(new Date(this.now()).toISOString());}
}
