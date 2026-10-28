import { randomBytes, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { mapBillingDocument } from '../services/billing-service/src/integration/read';
import { readFixture, issuerRuc } from './integration-read.fixture';
import { IntegrationExports, binding } from '../services/integration-export-service/src/core';
import { ExportVault } from '../services/integration-export-service/src/vault';
import { ExportQuotas, type ExportStore, type ExportRecord } from '../services/integration-export-service/src/model';
import { deny, snapshotHash } from '../packages/service-access/src/integration';
/** Test double ONLY; production always requires the dedicated persistent PostgreSQL store. */
export class FixtureExportStore implements ExportStore {
  records=new Map<string,ExportRecord>();leases=new Map<string,number>();events:any[]=[];
  constructor(readonly now:()=>number) {}
  async reserve(r:ExportRecord) {
    const existing=r.keyHash?[...this.records.values()].find(v=>v.clientId===r.clientId&&v.keyHash===r.keyHash):null;
    if(existing) return {record:this.clone(existing),created:false};
    const active=[...this.records.values()].filter(v=>Date.parse(v.expiresAt)>this.now()&&!['EXPIRED','FAILED'].includes(v.state));
    if(active.length>=64||active.filter(v=>v.clientId===r.clientId&&v.kind===r.kind).length>=(r.kind==='CUT'?8:2)) return deny(429,'RATE_LIMITED');
    this.records.set(r.id,structuredClone(r));return {record:r,created:true};
  }
  async get(id:string,clientId:string) {const r=this.records.get(id);return r?.clientId===clientId?this.clone(r):null;}
  async byKey(clientId:string,keyHash:string) {const r=[...this.records.values()].find(r=>r.clientId===clientId&&r.keyHash===keyHash);return r?this.clone(r):null;}
  private clone(r:ExportRecord):ExportRecord {return {...r,payload:r.payload?Buffer.from(r.payload):null,content:r.content?Buffer.from(r.content):null};}
  async captured(id:string,payload:Buffer,state:'QUEUED'|'READY') {const r=this.records.get(id)!;if(r.state!=='CAPTURING') return deny(409,'CONSISTENT_READ_UNAVAILABLE');r.payload=payload;r.state=state;}
  async fail(id:string,code:any,lease?:string) {const r=this.records.get(id)!;if(lease&&r.lease!==lease)return;
    if(['CAPTURING','QUEUED','RUNNING'].includes(r.state))Object.assign(r,{state:'FAILED',failureCode:code,payload:null,content:null,lease:null});}
  async claim(now:string) {const r=[...this.records.values()].find(r=>r.kind==='EXPORT'&&Date.parse(r.expiresAt)>Date.parse(now)&&
    (r.state==='QUEUED'||(r.state==='RUNNING'&&(this.leases.get(r.id)??Infinity)<=Date.parse(now))));
    if(!r)return null;r.state='RUNNING';r.lease=randomUUID();this.leases.set(r.id,Date.parse(now)+ExportQuotas.leaseMs);return this.clone(r);}
  async ready(id:string,lease:string,payload:Buffer,content:Buffer,contentSha256:string,manifestSha256:string,expiresAt:string) {
    const r=this.records.get(id)!;if(r.state!=='RUNNING'||r.lease!==lease)return deny(409,'CONSISTENT_READ_UNAVAILABLE');
    Object.assign(r,{state:'READY',lease:null,payload,content,contentSha256,manifestSha256,expiresAt});}
  audit=vi.fn(async(e:any)=>{this.events.push(e);});
  async sweep(now:string) {for(const r of this.records.values())if(Date.parse(r.expiresAt)<=Date.parse(now))Object.assign(r,{state:'EXPIRED',payload:null,content:null,lease:null});}
}
export function exportFixture() {
  const f=readFixture();let clock=1800000000000;
  f.p.scopes.push('integration:exports:create','integration:exports:read');
  const store=new FixtureExportStore(()=>clock),key=randomBytes(32),vault=new ExportVault(key);
  const old=f.billingHttp.json;
  const billingHttp={...f.billingHttp,json:vi.fn(async(path:string,token:string,body?:any)=>{
    if(path.endsWith('/capture')) {
      await f.identity.authenticate(token,['integration:documents:read']);
      const selected=[...f.rows.values()].filter(r=>body.types.split(',').includes(r.immutableSnapshot.documentTypeCode)).map(r=>mapBillingDocument(r,f.p,issuerRuc,new Date(clock)).document)
        .filter(d=>d.issueDate>=body.from&&d.issueDate<=body.to);
      const types=body.types.split(',').map((type:string)=>({type,state:['01','03','07','08'].includes(type)?'READY':'UNSUPPORTED',reasonCode:['01','03','07','08'].includes(type)?null:'SOURCE_NOT_SUPPORTED'}));
      return {documents:selected.sort((a,b)=>a.issuedAt!.localeCompare(b.issuedAt!)||a.id.localeCompare(b.id)),snapshotAt:new Date(clock).toISOString(),coverage:{types,complete:types.every((t:any)=>t.state==='READY')}};
    }
    if(path.endsWith('/reauthorize')) {
      for(const v of body.bindings) {
        const row=f.rows.get(v.id);if(!row) return deny(404,'RESOURCE_NOT_FOUND');
        const current=mapBillingDocument(row,f.p,issuerRuc).document;
        if(snapshotHash(binding(current))!==snapshotHash(v)) return deny(409,'EVIDENCE_INCONSISTENT');
      }
      return {valid:true};
    }
    if(path.includes('capture-ready'))return {ready:true};return old(path,token);
  })};
  const core=new IntegrationExports(store,vault,f.identity,billingHttp as any,f.sunatHttp as any,()=>clock);
  const query={issuerRuc,from:'2026-01-01',to:'2026-01-01',types:'01,03',limit:'1'};
  const request={filters:{issuerRuc,from:'2026-01-01',to:'2026-01-01',types:['01']},artifactKinds:['SIGNED_XML'],missingArtifacts:'FAIL',dataFormat:'JSONL'};
  return {...f,billingHttp,core,store,vault,key,query,request,now:()=>clock,advance:(ms:number)=>{clock+=ms;f.advance(ms);}};
}
