import { createRequire } from 'node:module';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join,dirname,basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { prepareHistoricalImport,historicalSha256 } from '../packages/history-core/src';
import { B2bSecurityError,type B2bPrincipal } from '../packages/contracts/src/b2b-security';
import { HistoryArchiveRepository } from '../services/history-service/src/repository';
import { HistoryArtifactStore } from '../services/history-service/src/artifact-store';
import { B2bHistoryReads,SyntheticB2bHistoryArchive,type B2bHistoryArchiveDecision } from '../services/history-service/src/b2b';
const fixtures=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
export function historyFixture() {
  const input=fixtures.exported(1,true),plan=prepareHistoricalImport(input),snapshot=plan.records[0].snapshot,m=snapshot.ownership;
  const root=mkdtempSync(join(tmpdir(),'factuez-history-persist-qa-')),markerId=randomUUID();
  const sourceRoot=join(root,'source'),archiveRoot=join(root,'archive');
  for(const dir of [sourceRoot,archiveRoot]){mkdirSync(dir);writeFileSync(join(dir,'.history-qa-marker.json'),JSON.stringify({profile:'factuez-history-storage-qa-v1',markerId}));}
  const artifactKeys=snapshot.artifacts.map(a=>({kind:a.kind,key:`${plan.records[0].snapshotSha256}/${a.kind}/${a.originalName}`}));
  for(const a of snapshot.artifacts){const name=join(archiveRoot,plan.records[0].snapshotSha256,a.kind,a.originalName);mkdirSync(dirname(name),{recursive:true});writeFileSync(name,fixtures.artifactBytes(a.kind));const source=join(sourceRoot,m.issuerRuc,m.documentTypeCode,m.series,snapshot.number,a.kind,a.originalName);mkdirSync(dirname(source),{recursive:true});writeFileSync(source,fixtures.artifactBytes(a.kind));}
  const row:any={...m,recordId:plan.records[0].recordId,snapshotSha256:plan.records[0].snapshotSha256,snapshot,artifactKeys,number:1n,
    originSystem:'RESTOAPP',originId:snapshot.originId,issueDate:new Date(snapshot.issueDate),currencyCode:snapshot.currencyCode,
    taxableAmount:{toFixed:()=>snapshot.amounts.taxableAmount},igvAmount:{toFixed:()=>snapshot.amounts.igvAmount},payableAmount:{toFixed:()=>snapshot.amounts.payableAmount},candidateOnly:true,disposition:'QUARANTINED'};
  const databaseName='factuez_history_qa_aabbccddee';
  const tx:any={$queryRaw:vi.fn(async()=>[{database:databaseName,role:'history_reader_qa'}]),
    historySandbox:{findUnique:vi.fn(async()=>({markerId,schemaVersion:'factuez.history-storage.v1',environment:'BETA',datasetClass:'SYNTHETIC'}))},
    historyRecord:{findFirst:vi.fn(async()=>row),findMany:vi.fn(async()=>[row])}};
  const prisma={$transaction:vi.fn(async(work:any)=>work(tx))},repository=new HistoryArchiveRepository(prisma as any,{databaseName,markerId},'READ_ONLY');
  const artifacts=new HistoryArtifactStore({sourceRoot,archiveRoot,markerId});
  const binding={issuerId:m.companyId,issuerRuc:m.issuerRuc,environment:'BETA' as const,branchId:m.branchId,pointId:m.emissionPointId,seriesId:m.seriesCounterId,documentType:m.documentTypeCode as '03'};
  const p:B2bPrincipal={kind:'SERVICE',clientId:fixtures.uuid(700),revision:1,subjectId:null,userAuthRevision:null,
    environment:'BETA',scopes:['b2b:history:read','b2b:artifacts:read'],bindings:[binding]};
  let enrolled=true;
  const decision:B2bHistoryArchiveDecision={environment:'BETA',datasetClass:'SYNTHETIC',permission:'history.view',enrollmentId:'synthetic_archive_enrollment',revision:'1',binding,actor:fixtures.actor(false)};
  const permission={authorizeCurrent:vi.fn(async()=>enrolled?structuredClone(decision):null)};
  const identity={authenticate:vi.fn(async(token:string,scopes:any[],kind:any)=>{
    if(token!=='synthetic-b2b-history-token'||kind!==p.kind)throw new B2bSecurityError(401,'INVALID_PRINCIPAL');
    if(scopes.some(s=>!p.scopes.includes(s)))throw new B2bSecurityError(403,'SCOPE_REQUIRED');return structuredClone(p);
  })};
  const archive=new SyntheticB2bHistoryArchive(repository,artifacts,permission),reader=new B2bHistoryReads(identity,archive,{enabled:true,environment:'BETA',datasetClass:'SYNTHETIC'});
  return {p,binding,decision,identity,permission,reader,archive,repository,artifacts,row,tx,prisma,recordId:row.recordId,input,plan,markerId,
    auth:{token:'synthetic-b2b-history-token',kind:'SERVICE' as const},unenroll:()=>{enrolled=false;},
    close:()=>{const target=resolve(root),temp=resolve(tmpdir());if(dirname(target)!==temp||!/^factuez-history-persist-qa-[a-zA-Z0-9]+$/.test(basename(target)))throw new Error('TEMP_SCOPE');rmSync(target,{recursive:true,force:true});}};
}