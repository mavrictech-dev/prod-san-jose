import { vi } from 'vitest';
import { B2bSecurityError, type B2bPrincipal } from '../packages/contracts/src/b2b-security';
import { B2bBillingReads } from '../services/billing-service/src/b2b/read';
import { B2bReports } from '../services/billing-service/src/b2b/phase8-reports';
import type { ReportJob, ReportFile, ReportsStore, ReportsTransaction, ReportsRenderers } from '../services/billing-service/src/b2b/phase8-reports';
import { sale, branchId, pointId, counterId, issuerRuc } from './integration-read.fixture';
export const binding={issuerId:1,issuerRuc,environment:'BETA' as const,branchId,pointId,seriesId:counterId,documentType:'01' as const};
export const filters={issuerId:'1',environment:'BETA',from:'2026-01-01',to:'2026-01-02',types:'01'};
export const createInput={filters,format:'CSV',idempotencyKey:'reports_synthetic_0001'};
/** Only used by tests. Snapshot/rollback and serialization model actual transactional boundaries. */
export class TestReportsStore implements ReportsStore {
  jobs=new Map<string,ReportJob>();files=new Map<string,ReportFile>();private queue:Promise<unknown>=Promise.resolve();
  transaction<T>(_key:string,work:(tx:ReportsTransaction)=>Promise<T>):Promise<T> {
    const run=async()=>{
      const jobs=structuredClone(this.jobs),files=new Map([...this.files].map(([k,v])=>[k,{...v,bytes:Buffer.from(v.bytes)}]));
      const tx:ReportsTransaction={
        prior:async(o,k)=>structuredClone([...jobs.values()].find(j=>j.ownerKey===o&&j.keyHash===k)??null),
        get:async(o,id)=>{const j=jobs.get(id);return structuredClone(j?.ownerKey===o?j:null);},
        insert:async j=>{if([...jobs.values()].some(x=>x.ownerKey===j.ownerKey&&x.keyHash===j.keyHash)) throw new Error('UNIQUE');jobs.set(j.id,structuredClone(j));},
        complete:async(o,id,v,f)=>{const j=jobs.get(id);if(!j||j.ownerKey!==o||j.state!=='QUEUED'||j.revision!==v)return false;
          const {bytes,...content}=f;files.set(id,{...content,bytes:Buffer.from(bytes)});jobs.set(id,{...j,state:'READY',revision:v+1,content});return true;},
        content:async(o,id)=>{if(jobs.get(id)?.ownerKey!==o)return null;const f=files.get(id);return f?{...f,bytes:Buffer.from(f.bytes)}:null;},
      };
      const result=await work(tx);this.jobs=jobs;this.files=files;return result;
    };
    const result=this.queue.then(run);this.queue=result.catch(()=>{});return result;
  }
}
export function reportsFixture(options:{enabled?:boolean;renderers?:ReportsRenderers;store?:ReportsStore}={}) {
  const p:B2bPrincipal={kind:'SERVICE',clientId:'80000000-0000-4000-8000-000000000001',revision:1,subjectId:null,userAuthRevision:null,
    environment:'BETA',scopes:['b2b:reports:read','b2b:reports:export','b2b:documents:read'],bindings:[structuredClone(binding)]};
  const identity={authenticate:vi.fn(async(t:string,s:any[],kind:'SERVICE'|'USER')=>{
    if(t!=='synthetic-report-token'||kind!==p.kind)throw new B2bSecurityError(401,'INVALID_PRINCIPAL');
    if(s.some(scope=>!p.scopes.includes(scope)))throw new B2bSecurityError(403,'SCOPE_REQUIRED');return structuredClone(p);
  })};
  const rows=[sale()],repository:any={capture:vi.fn(async()=>structuredClone(rows))};
  const billing=new B2bBillingReads(repository,identity),port={execute:vi.fn((t:string,k:'SERVICE'|'USER',a:string,i:unknown)=>billing.execute(t,k,a,i))};
  const store=options.store??new TestReportsStore(),auth={token:'synthetic-report-token',kind:'SERVICE' as const};
  const reports=new B2bReports(store,identity,port,{enabled:options.enabled??true,renderers:options.renderers});
  return {p,identity,rows,repository,billing,port,store:store as TestReportsStore,reports,auth};
}