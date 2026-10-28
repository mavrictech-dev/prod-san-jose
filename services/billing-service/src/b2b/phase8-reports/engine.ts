import { randomUUID } from 'node:crypto';
import { b2bBindingKey, b2bBindingsContain, type B2bIdentityScope, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import type { ReportJob, ReportsAction, ReportsAuth, ReportsCapturePort, ReportsFormat, ReportsRenderers, ReportsStore, ReportFile } from './types';
import { captureResult, extended, fail, hashBytes, keys, limits, matches, object, sealCapture, summary, verifyCapture } from './validation';
import { createReportsRenderers } from './renderers';
import { reportsFilters } from './filters';
import type { ReportsSupplementalSources } from './source-types';
const policy={schemaVersion:'factuez.b2b.reports.v1',environment:'BETA',source:'BILLING_01_03',candidateOnly:true,fiscalAuthority:false} as const;
const reportPolicy=(c:import('./types').ReportsCapture)=>({...policy,...(extended(c.filters)?{source:'BILLING_OWNER_SOURCES'}:{})});
const actor=(p:B2bPrincipal)=>({kind:p.kind,clientId:p.clientId,subjectId:p.subjectId,revision:p.revision,userAuthRevision:p.userAuthRevision});
export const reportsActorKey=(p:B2bPrincipal)=>snapshotHash({audience:'factuez.b2b.reports.v1',...actor(p)});
const metadata=(j:ReportJob)=>({id:j.id,state:j.state,revision:j.revision,format:j.format,createdAt:j.createdAt,
  capturedAt:j.capture.capturedAt,captureSha256:j.capture.sha256,count:j.capture.rows.length,content:j.content,...(extended(j.capture.filters)?{types:j.capture.filters.types}:{} )});
/** Explicitly composed candidate owner. No routes, network, env, timers or default activation. */
export class B2bReports {
  private readonly renderers:ReportsRenderers;
  constructor(private readonly store:ReportsStore,private readonly identity:B2bIdentityPort,private readonly billing:ReportsCapturePort,
    private readonly options:{enabled?:boolean;renderers?:ReportsRenderers;now?:()=>number;sources?:ReportsSupplementalSources}={}) {
    this.renderers={...createReportsRenderers(),...options.renderers};
  }
  async execute(auth:ReportsAuth,action:ReportsAction,input:unknown):Promise<any> {
    if(this.options.enabled!==true) fail(503,'REPORTS_DISABLED');
    const a=object(auth);keys(a,['token','kind']);
    if(typeof a.token!=='string'||!a.token||a.token.length>16384||!['USER','SERVICE'].includes(a.kind)||
      !['DASHBOARD','CREATE','READ','CONTENT'].includes(action)) fail(400,'INVALID_REQUEST');
    const token=a.token as string,kind=a.kind as 'USER'|'SERVICE';
    let raw:Record<string,any>;try{raw=object(structuredClone(input));}catch{return fail(400,'INVALID_REQUEST');}
    keys(raw,action==='CREATE'?['filters','format','idempotencyKey']:action==='DASHBOARD'?['filters']:['id']);
    if(Buffer.byteLength(JSON.stringify(raw))>16384) fail(413,'REQUEST_TOO_LARGE');
    const required:B2bIdentityScope[]=['b2b:reports:read','b2b:documents:read'];
    if(action==='CREATE'||action==='CONTENT') required.push('b2b:reports:export');
    const frame=new B2bOwnerReadFrame(this.identity,kind),p=await frame.principal(token,required),owner=reportsActorKey(p);
    const current=async()=>frame.principal(token,required);
    const authorizeJob=async(job:ReportJob|null)=>{
      if(!job||job.ownerKey!==owner||snapshotHash(job.actor)!==snapshotHash(actor(p))) fail(404,'RESOURCE_NOT_FOUND');
      verifyCapture(job.capture);
      const fresh=await current();
      if(job.capture.bindings.some(b=>!b2bBindingsContain(fresh.bindings,b))) fail(404,'RESOURCE_NOT_FOUND');
      if(extended(job.capture.filters)){
        if(!this.options.sources)fail(503,'REPORT_SOURCES_NOT_CONFIGURED');
        await this.options.sources.authorize({token,kind},fresh,job.capture);await current();
      }
      if(job.contentPurgedAt!==undefined) fail(410,'ARTIFACT_NOT_AVAILABLE');
      return job;
    };
    const capture=async()=>{
      const filters=reportsFilters(raw.filters,!!this.options.sources),bindings=p.bindings.filter(b=>matches(b,filters)).sort((a,b)=>b2bBindingKey(a).localeCompare(b2bBindingKey(b)));
      if(!bindings.length) fail(404,'RESOURCE_NOT_FOUND');
      if(new Set(bindings.map(b=>b.issuerRuc)).size!==1)fail(409,'INCONSISTENT_CONTEXT');
      await current();
      const salesTypes=filters.types.filter((t):t is '01'|'03'=>t==='01'||t==='03');
      let rows:import('./types').ReportRow[]=[],capturedAt=new Date((this.options.now??Date.now)()).toISOString();
      if(salesTypes.length){
        const {issuerRuc,...base}=raw.filters;
        const salesFilters=reportsFilters({...base,types:salesTypes.join(',')});
        const selected=bindings.filter(b=>matches(b,salesFilters));
        if(!selected.length)fail(404,'RESOURCE_NOT_FOUND');
        const c=captureResult(await this.billing.execute(token,kind,'capture',{...base,types:salesTypes.join(',')}),salesFilters,selected);
        rows=c.rows;capturedAt=c.capturedAt;
      }
      let result;
      if(extended(filters)){
        const supplement=await this.options.sources!.capture({token,kind},await current(),filters);
        capturedAt=supplement.capturedAt;
        result=sealCapture({capturedAt,filters,bindings,rows:[...rows,...supplement.rows],access:supplement.access});
        await this.options.sources!.authorize({token,kind},await current(),result);
      }else result=sealCapture({capturedAt,filters,bindings,rows});
      const fresh=await current();
      if(result.bindings.some(b=>!b2bBindingsContain(fresh.bindings,b))) fail(404,'RESOURCE_NOT_FOUND');
      return result;
    };
    if(action==='DASHBOARD') {const c=await capture(),data=summary(c);await current();return {...reportPolicy(c),data};}
    if(action==='READ'||action==='CONTENT') {
      if(!b2bUuid(raw.id)) fail(400,'INVALID_ID');
      return this.store.transaction(`read:${owner}:${raw.id}`,async tx=>{
        const job=await authorizeJob(await tx.get(owner,raw.id));
        if(action==='READ') {await current();return {...reportPolicy(job.capture),data:metadata(job)};}
        if(job.state!=='READY'||!job.content) fail(409,'REPORT_NOT_READY');
        const file=await tx.content(owner,raw.id);
        if(!file||file.bytes.length>limits.contentBytes||file.sizeBytes!==file.bytes.length||hashBytes(file.bytes)!==file.sha256||
          snapshotHash(job.content)!==snapshotHash({sha256:file.sha256,mediaType:file.mediaType,fileName:file.fileName,sizeBytes:file.sizeBytes})) fail(409,'REPORT_CONTENT_INTEGRITY');
        await authorizeJob(job);await current();return {...file,bytes:Buffer.from(file.bytes)};
      });
    }
    if(typeof raw.idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(raw.idempotencyKey)) fail(400,'INVALID_IDEMPOTENCY_KEY');
    if(!['CSV','XLSX','PDF'].includes(raw.format)||!this.renderers[raw.format as ReportsFormat]) fail(422,'FORMAT_NOT_AVAILABLE');
    const filters=reportsFilters(raw.filters,!!this.options.sources),format=raw.format as ReportsFormat,keyHash=hashBytes(Buffer.from(raw.idempotencyKey)),requestHash=snapshotHash({filters,format});
    let replayed=false;
    const job=await this.store.transaction(`create:${owner}:${keyHash}`,async tx=>{
      const prior=await tx.prior(owner,keyHash);
      if(prior){if(prior.requestHash!==requestHash) fail(409,'IDEMPOTENCY_CONFLICT');replayed=true;return authorizeJob(prior);}
      const c=await capture();
      const created:ReportJob={id:randomUUID(),ownerKey:owner,keyHash,requestHash,actor:actor(p),state:'QUEUED',revision:1,format,
        createdAt:new Date((this.options.now??Date.now)()).toISOString(),capture:c,content:null};
      await tx.insert(created);await current();return created;
    });
    if(job.state==='READY'){await current();return {...reportPolicy(job.capture),data:metadata(job),replayed};}
    await authorizeJob(job);
    let rendered:{bytes:Buffer;mediaType:string};
    try{rendered=await this.renderers[format]!(structuredClone(job.capture));}catch{return fail(503,'REPORT_RENDER_FAILED');}
    if(!Buffer.isBuffer(rendered.bytes)||!rendered.bytes.length||rendered.bytes.length>limits.contentBytes) fail(413,'REPORT_CONTENT_TOO_LARGE');
    const mime={CSV:'text/csv; charset=utf-8',XLSX:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',PDF:'application/pdf'}[format];
    if(rendered.mediaType!==mime) fail(409,'REPORT_CONTENT_INVALID');
    const file:ReportFile={bytes:Buffer.from(rendered.bytes),sha256:hashBytes(rendered.bytes),mediaType:mime,
      fileName:`b2b-report-${job.id}.${format.toLowerCase()}`,sizeBytes:rendered.bytes.length};
    return this.store.transaction(`complete:${owner}:${job.id}`,async tx=>{
      const saved=await authorizeJob(await tx.get(owner,job.id));
      if(saved.state==='QUEUED') await tx.complete(owner,job.id,job.revision,file);
      const ready=await authorizeJob(await tx.get(owner,job.id));
      if(ready.state!=='READY') fail(409,'REPORT_CAS_CONFLICT');
      await current();return {...reportPolicy(ready.capture),data:metadata(ready),replayed};
    });
  }
}


