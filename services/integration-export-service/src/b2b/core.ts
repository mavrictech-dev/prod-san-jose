import { B2bSecurityError,type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { b2bIssuerId,b2bQuery,b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { B2bContractVersion } from '@factuez/contracts/b2b';
import { IntegrationExports } from '../core';
import { IntegrationChanges } from '../changes';
import type { OwnerHttp,ExportStore } from '../model';
import type { ChangeDeliveryStore } from '../change-store';
import { ExportVault } from '../vault';
export interface B2bExtractionPersistence {domain:'B2B_BETA_ISOLATED';exports:ExportStore;changes:ChangeDeliveryStore;vault:ExportVault}
export interface B2bExtractionOwner {execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<any>;file?(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<{bytes:Buffer;sha256:string;fileName:string;mediaType:string}>}
export class HttpB2bExtractionOwner implements B2bExtractionOwner {
  constructor(private readonly http:B2bPrivateHttp,private readonly fiscal=false){}
  execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){return this.http.post(this.fiscal?'/internal/b2b/fiscal-read':'/internal/b2b/read',{kind,action,args},token);}
  file(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){if(!this.fiscal)throw new B2bSecurityError(400,'INVALID_OWNER');return this.http.file({kind,action,args},token);}
}
/** Translates only fixed ENGINE calls into B2B owner calls. No legacy HTTP guard/token exchange. */
class OwnerEnginePort implements OwnerHttp {
  constructor(private readonly owner:B2bExtractionOwner,private readonly fiscal:boolean,private readonly frame:B2bOwnerReadFrame){}
  private async parse(path:string,token:string,body?:any){
    if(!/^\/internal\/integration\/[a-z0-9/-]+(?:\?|$)/.test(path)||path.includes('..'))throw new B2bSecurityError(400,'INVALID_OWNER_REQUEST');
    const u=new URL(path,'https://engine.invalid');for(const k of u.searchParams.keys())if(u.searchParams.getAll(k).length!==1)throw new B2bSecurityError(400,'INVALID_OWNER_REQUEST');
    const q=Object.fromEntries(u.searchParams),ruc=q.issuerRuc??body?.issuerRuc,p=await this.frame.principal(token,['b2b:documents:read']);
    const ids=[...new Set(p.bindings.filter(b=>b.issuerRuc===ruc).map(b=>b.issuerId))];if(ids.length!==1)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    return {u,q,issuerId:String(ids[0])};
  }
  async json<T>(path:string,token:string,body?:unknown):Promise<T>{
    const {u,q,issuerId}=await this.parse(path,token,body),suffix=u.pathname.slice('/internal/integration/'.length);let action:string,args:unknown;
    if(!this.fiscal){
      if(['capture','reauthorize'].includes(suffix)){action='extract:'+suffix;args=body;}
      else if(['journal','change-ready','capture-ready'].includes(suffix)){action='extract:'+suffix;args=q;}
      else{const m=/^(documents|batches)\/([a-f0-9-]{36})$/.exec(suffix);if(!m)throw new B2bSecurityError(400,'INVALID_OWNER_REQUEST');action=m[1]==='documents'?'extract:document':'extract:batch';args={...q,id:m[2]};}
    }else if(['journal','change-ready'].includes(suffix)){action='extract:'+suffix;args=q;}
    else{const m=/^(documents|batches)\/([a-f0-9-]{36})(\/artifacts)?$/.exec(suffix);if(!m||(!m[3]&&m[1]!=='batches'))throw new B2bSecurityError(400,'INVALID_OWNER_REQUEST');action=m[3]?(m[1]==='documents'?'artifacts':'batch-artifacts'):'batch';args={issuerId,environment:'BETA',id:m[2]};}
    return this.owner.execute(token,this.frame.kind,action,args);
  }
  async bytes(path:string,token:string){
    const {u,issuerId}=await this.parse(path,token),m=/^\/internal\/integration\/artifacts\/([a-f0-9-]{36})\/content$/.exec(u.pathname);
    if(!this.fiscal||!m||!this.owner.file)throw new B2bSecurityError(400,'INVALID_OWNER_REQUEST');
    const f=await this.owner.file(token,this.frame.kind,'content',{issuerId,environment:'BETA',id:m[1]});
    return {bytes:f.bytes,headers:{'content-type':f.mediaType,'x-content-sha256':f.sha256,'content-length':String(f.bytes.length)}};
  }
}
/** Candidate B2B entry to the existing persistent cut/export/feed engines. */
export class B2bExtraction {
  private active=0;
  constructor(private readonly persistence:B2bExtractionPersistence,private readonly identity:B2bIdentityPort,private readonly billing:B2bExtractionOwner,private readonly fiscal:B2bExtractionOwner,private readonly now=Date.now){
    if(persistence.domain!=='B2B_BETA_ISOLATED')throw new Error('Dedicated B2B persistence required');
  }
  private engines(kind:'SERVICE'|'USER'){
    if(!['SERVICE','USER'].includes(kind))throw new B2bSecurityError(400,'INVALID_ACTOR_KIND');
    const frame=new B2bOwnerReadFrame(this.identity,kind),billing=new OwnerEnginePort(this.billing,false,frame),sunat=new OwnerEnginePort(this.fiscal,true,frame);
    const feed=new IntegrationChanges(this.persistence.changes,this.persistence.vault,frame,billing,sunat,this.now);
    return {frame,feed,core:new IntegrationExports(this.persistence.exports,this.persistence.vault,frame,billing,sunat,this.now,feed)};
  }
  async execute(token:string,kind:'SERVICE'|'USER',action:string,args:any){
    if(this.active>=2)throw new B2bSecurityError(429,'RATE_LIMITED');this.active++;
    try{
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='body,id,key,query')throw new B2bSecurityError(400,'INVALID_REQUEST');
      const {frame,core}=this.engines(kind),create=action==='create';
      const q=b2bQuery(args.query,action==='documents'?['issuerId','environment','from','to','types','branchId','pointId','series','currency','fiscalStatus','limit','cursor']:action==='changes'?['issuerId','environment','checkpoint','limit']:action==='detail'?['issuerId','environment','snapshotId']:['issuerId','environment'],['issuerId','environment']);
      const issuerId=b2bIssuerId(q.issuerId),required:B2bIdentityScope[]=action==='changes'?['b2b:documents:read','b2b:changes:read']:create?['b2b:documents:read','b2b:exports:create']:['documents','detail'].includes(action)?['b2b:documents:read']:['b2b:documents:read','b2b:exports:read'];
      const p=await frame.principal(token,required),rucs=[...new Set(p.bindings.filter(b=>b.issuerId===issuerId).map(b=>b.issuerRuc))];if(rucs.length!==1)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
      const {issuerId:_id,...rest}=q,legacy={...rest,issuerRuc:rucs[0]};
      if(q.types&&q.types.split(',').some(t=>!['01','03'].includes(t)))throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
      let payload:any;
      if(action==='documents')payload=await core.documents(token,{...legacy,types:q.types??'01,03'});
      else if(action==='changes')payload=await core.changes(token,legacy);
      else if(action==='detail'){
        if(!b2bUuid(args.id)||!b2bUuid(q.snapshotId))throw new B2bSecurityError(400,'INVALID_ID');payload=await core.detail(token,args.id,q.snapshotId,rucs[0]);
      }else if(create){
        const b=args.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='artifactKinds,dataFormat,filters,missingArtifacts'||!b.filters||typeof b.filters!=='object'||Array.isArray(b.filters)||'issuerRuc'in b.filters||'issuerId'in b.filters)throw new B2bSecurityError(400,'INVALID_REQUEST');
        if(b.filters.environment!==undefined&&b.filters.environment!=='BETA')throw new B2bSecurityError(400,'ENVIRONMENT_NOT_ALLOWED');
        const types=b.filters.types??['01','03'];if(!Array.isArray(types)||types.some((t:unknown)=>!['01','03'].includes(String(t))))throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
        payload=await core.create(token,args.key,{...b,filters:{...b.filters,issuerRuc:rucs[0],environment:'BETA',types}});
      }else{
        if(!b2bUuid(args.id))throw new B2bSecurityError(400,'INVALID_ID');
        if(action==='status')payload=await core.status(token,args.id,rucs[0]);
        else if(action==='manifest')payload=await core.manifest(token,args.id,rucs[0]);
        else if(action==='content'){const file=await core.content(token,args.id,rucs[0]);await frame.principal(token,required);return file;}
        else throw new B2bSecurityError(400,'INVALID_ACTION');
      }
      await frame.principal(token,required);return {schemaVersion:B2bContractVersion,payloadContract:'factuez.integration.v1',payload};
    }finally{this.active--;}
  }
  /** Dedicated queue/vault; no bearer is saved or needed by the packaging worker. */
  async runOne(){const core=this.engines('SERVICE').core;return core.runOne();}
  async sweep(){await this.persistence.exports.sweep(new Date(this.now()).toISOString());await this.persistence.changes.sweep(new Date(this.now()).toISOString());}
}
