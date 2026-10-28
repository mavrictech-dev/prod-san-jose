import {describe,expect,it,vi} from 'vitest';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {PostgresGuideIssueContext} from '../services/billing-service/src/b2b/guide-issue-context';
import {transactionBoundGuideEstablishmentStore,type GuideEstablishmentSql} from '../services/billing-service/src/b2b/guide-establishment-store';
import {transactionBoundGuideGoodsStore} from '../services/billing-service/src/b2b/guide-goods-store';
import type {GuideDraft} from '../services/billing-service/src/b2b/guide-model';
import type {GuideIssueBinding} from '../services/billing-service/src/b2b/guide-issue-model';
import {establishmentFixture} from './helpers/b2b-guide-establishments.fixture';
import {guideGoodsFixture} from './helpers/b2b-guide-goods.fixture';
import {guideUuid} from './helpers/b2b-guide.fixture';

type Call={sql:string;values:unknown[]};
type Row=Record<string,unknown>;
const signed=<T extends {sha256:string}>(value:T):T=>{
  const {sha256:_,...unsigned}=value;return {...value,sha256:fiscalSnapshotSha256(unsigned)};
};

/** SQL is simulated, never executed. Actual strict cores create and validate the
 * synthetic registries. Only persistence is doubled, with SELECT projections,
 * WHERE scopes, current-head membership and transaction lock lifetime enforced. */
async function fixture(){
  const e=establishmentFixture(),g=guideGoodsFixture();
  await e.replace();await g.replace();
  const binding:GuideIssueBinding={draft:structuredClone(e.binding),fiscalSeriesId:guideUuid(60)};
  const body=structuredClone(e.body);
  const draft:GuideDraft={id:guideUuid(61),clientId:guideUuid(62),actorKey:'SERVICE',binding:binding.draft,body,
    revision:1,state:'READY',bodySha256:fiscalSnapshotSha256(body),
    createdAt:'2026-10-22T15:00:00.000Z',updatedAt:'2026-10-22T15:00:00.000Z'};
  const company={...e.company,legalName:body.sender.legalName};
  const branches=[...e.store.state.branches.values()].filter(b=>b.companyId===company.id);
  const point={id:binding.draft.anchor.pointId,companyId:company.id,branchId:binding.draft.anchor.branchId,active:true,masterRevision:4};
  const anchor={id:binding.draft.anchor.seriesId,companyId:company.id,emissionPointId:point.id,
    documentType:'INVOICE',series:'F001',active:true,masterRevision:6};
  const counter={...anchor,id:binding.fiscalSeriesId,documentType:'DESPATCH_ADVICE',series:'T001',nextNumber:1n,masterRevision:8};
  const draftSeries={id:binding.draft.guideSeriesId,companyId:company.id,pointId:point.id,
    guideType:'09',label:'T001',revision:9,active:true,purpose:'DRAFT_ONLY'};
  const mapping={draftSeriesId:draftSeries.id,fiscalSeriesId:counter.id,companyId:company.id,
    revision:10,active:true,purpose:'LOCAL_CANDIDATE'};
  const state={company,branches,point,anchor,counter,draftSeries,mapping,
    establishments:e.store.state.heads.get(company.id)!,goods:g.store.state.heads.get(company.id)!,
    product:g.product,missing:new Set<string>()};
  const calls:Call[]=[],locks=new Set<string>();
  const control:{inside:boolean;before?:(call:Call)=>void;override?:(table:string,rows:Row[])=>Row[]}={inside:false};
  const project=(sql:string,rows:Row[])=>{
    const fields=sql.slice(7,sql.indexOf(' FROM')).split(',').map(f=>f.trim().replaceAll('"',''));
    return rows.map(row=>Object.fromEntries(fields.map(field=>[field,row[field]])));
  };
  const sql:GuideEstablishmentSql&{$transaction:ReturnType<typeof vi.fn>}={
    $transaction:vi.fn(async()=>{throw new Error('NESTED_TRANSACTION_FORBIDDEN');}),
    $executeRawUnsafe:vi.fn(async()=>{throw new Error('PERSISTENCE_WRITE_FORBIDDEN');}),
    $queryRawUnsafe:vi.fn(async<T=unknown>(text:string,...values:unknown[]):Promise<T>=>{
      expect(control.inside,'SQL must stay within caller transaction').toBe(true);
      const call={sql:text.replace(/\s+/g,' ').trim(),values};calls.push(call);control.before?.(call);
      expect(call.sql).not.toMatch(/\b(?:INSERT|UPDATE(?! OF|$)|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/);
      if(call.sql.includes('pg_advisory_xact_lock')){
        expect(call.sql).toBe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))');
        locks.add(String(values[0]));return [] as T;
      }
      expect([...locks].slice(0,2)).toEqual(['factuez:guide-establishments:1','factuez:guide-goods:1']);
      const table=/ FROM "([A-Za-z0-9]+)"/.exec(call.sql)?.[1];
      expect(table).toBeDefined();
      expect(call.sql).toMatch(/ FOR (?:UPDATE(?: OF h)?|SHARE)$/);
      if(state.missing.has(table!))return [] as T;
      if(table==='B2bGuideEstablishmentHead'||table==='B2bGuideGoodsHead'){
        expect(values).toEqual([company.id]);
        const prefix=table==='B2bGuideEstablishmentHead'?'B2bGuideEstablishment':'B2bGuideGoods';
        expect(call.sql).toContain(`LEFT JOIN "${prefix}Version" v ON v."companyId"=h."companyId" AND v."revision"=h."revision"`);
        expect(call.sql).toContain('WHERE h."companyId"=$1 FOR UPDATE OF h');
        const payload=table==='B2bGuideEstablishmentHead'?state.establishments:state.goods;
        const row={headCompanyId:company.id,headRevision:payload.revision,versionCompanyId:payload.companyId,
          versionRevision:payload.revision,payload};
        return structuredClone(control.override?.(table,[row])??[row]) as T;
      }
      let rows:Row[];
      switch(table){
        case 'CompanySettings':
          expect(call.sql).toContain('WHERE "id"=$1');
          expect(call.sql).toMatch(/ FOR UPDATE$/);
          rows=values[0]===company.id&&(!call.sql.includes('AND "active"=true')||state.company.active&&state.company.environment==='BETA')?[state.company]:[];break;
        case 'Branch':
          if(Array.isArray(values[1])){
            expect(call.sql).toContain('WHERE "companyId"=$1 AND "id"=ANY($2::uuid[]) ORDER BY "id" FOR SHARE');
            rows=state.branches.filter(r=>r.companyId===values[0]&&(values[1] as string[]).includes(r.id));
          }else{
            expect(call.sql).toContain('WHERE "id"=$1::uuid AND "companyId"=$2 FOR SHARE');
            rows=state.branches.filter(r=>r.id===values[0]&&r.companyId===values[1]);
          }break;
        case 'EmissionPoint':
          expect(call.sql).toContain('WHERE "id"=$1::uuid AND "companyId"=$2 FOR SHARE');
          rows=state.point.id===values[0]&&state.point.companyId===values[1]?[state.point]:[];break;
        case 'SeriesCounter':
          expect(call.sql).toContain('WHERE "id"=$1::uuid AND "companyId"=$2');
          expect(call.sql).toMatch(call.sql.includes('"nextNumber"')?/FOR UPDATE$/:/FOR SHARE$/);
          rows=[state.anchor,state.counter].filter(r=>r.id===values[0]&&r.companyId===values[1]);break;
        case 'B2bGuideDraftSeries':
          expect(call.sql).toContain('WHERE "id"=$1::uuid AND "companyId"=$2 FOR SHARE');
          rows=state.draftSeries.id===values[0]&&state.draftSeries.companyId===values[1]?[state.draftSeries]:[];break;
        case 'B2bGuideIssueSeries':
          expect(call.sql).toContain('WHERE "draftSeriesId"=$1::uuid AND "companyId"=$2 FOR SHARE');
          rows=state.mapping.draftSeriesId===values[0]&&state.mapping.companyId===values[1]?[state.mapping]:[];break;
        case 'FuelProduct':
          expect(call.sql).toContain('WHERE "id"=ANY($1::uuid[]) ORDER BY "id" FOR SHARE');
          rows=(values[0] as string[]).includes(state.product.id)?[state.product]:[];break;
        default:throw new Error('UNEXPECTED_FIXTURE_SQL');
      }
      return structuredClone(control.override?.(table!,project(call.sql,rows))??project(call.sql,rows)) as T;
    }),
  };
  const resolver=new PostgresGuideIssueContext();
  const outer=vi.fn(async<T>(work:(tx:GuideEstablishmentSql)=>Promise<T>)=>{
    expect(control.inside).toBe(false);control.inside=true;
    try{return await work(sql);}finally{control.inside=false;locks.clear();}
  });
  return {state,binding,draft,sql,resolver,calls,control,outer,
    prepare:()=>outer(tx=>resolver.prepare(tx,binding,draft)),
    clean(){
      expect(sql.$transaction).not.toHaveBeenCalled();expect(sql.$executeRawUnsafe).not.toHaveBeenCalled();
      for(const call of calls){
        const slots=[...new Set([...call.sql.matchAll(/\$(\d+)\b/g)].map(m=>Number(m[1])))].sort((a,b)=>a-b);
        expect(slots).toEqual(call.values.map((_,i)=>i+1));
        for(const value of call.values.flat())if(typeof value==='string')expect(call.sql).not.toContain(value);
      }
    }};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function denied(f:Fixture,code:string,status=409){
  const error=await f.prepare().then(()=>null,error=>error);
  expect(error).toBeInstanceOf(B2bSecurityError);expect(error).toMatchObject({code,status,message:code});
  expect(error.cause).toBeUndefined();f.clean();return error;
}

describe('PostgresGuideIssueContext: transaction-bound local candidate',()=>{
  it('constructs with no dependency, query or configuration read',()=>{
    expect(new PostgresGuideIssueContext()).toBeInstanceOf(PostgresGuideIssueContext);
  });
  it('returns only the contracted context; locks both registries before masters, allocates nothing and opens no nested transaction',async()=>{
    const f=await fixture(),result=await f.prepare();
    expect(Object.keys(result).sort()).toEqual(['contextSha256','counter','issuer']);
    expect(result.issuer).toEqual({ruc:f.state.company.ruc,legalName:f.state.company.legalName});
    expect(result.counter).toEqual({id:f.binding.fiscalSeriesId,series:'T001',nextNumber:'1',masterRevision:8});
    expect(result.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.state.counter.nextNumber).toBe(1n);expect(f.outer).toHaveBeenCalledTimes(1);
    expect(f.calls.slice(0,2).map(c=>c.values)).toEqual([['factuez:guide-establishments:1'],['factuez:guide-goods:1']]);
    expect(f.calls.at(-1)?.sql).toContain('FROM "FuelProduct"');f.clean();
  });
  it.each([1n,99999999n,'1','99999999'])('accepts canonical bounded BigInt/string next number %s',async value=>{
    const f=await fixture();f.state.counter.nextNumber=value as bigint;
    expect((await f.prepare()).counter.nextNumber).toBe(String(value));f.clean();
  });
  it.each([0n,-1n,100000000n,'01','1.0','1e1',' 1','1\n',1,null,{}])('rejects invalid counter without lossy coercion %s',async value=>{
    const f=await fixture();(f.state.counter as Row).nextNumber=value;await denied(f,'GUIDE_ISSUE_COUNTER_INVALID');
  });
  const invalidMasters:[string,(f:Fixture)=>void,string][]=[
    ['inactive company',f=>{f.state.company.active=false;},'ISSUER'],
    ['wrong RUC',f=>{f.state.company.ruc='20000000010';},'ISSUER'],
    ['production environment',f=>{(f.state.company as Row).environment='PRODUCTION';},'ISSUER'],
    ['empty legal name',f=>{f.state.company.legalName='';},'ISSUER'],
    ['control in legal name',f=>{f.state.company.legalName+='\n';},'ISSUER'],
    ['zero config revision',f=>{f.state.company.configVersion=0;},'ISSUER'],
    ['inactive branch',f=>{f.state.branches[0].active=false;},'BRANCH'],
    ['foreign branch',f=>{f.state.branches[0].companyId=2;},'BRANCH'],
    ['zero branch revision',f=>{f.state.branches[0].masterRevision=0;},'BRANCH'],
    ['inactive point',f=>{f.state.point.active=false;},'POINT'],
    ['foreign point',f=>{f.state.point.companyId=2;},'POINT'],
    ['wrong point branch',f=>{f.state.point.branchId=guideUuid(10);},'POINT'],
    ['inactive anchor',f=>{f.state.anchor.active=false;},'ANCHOR'],
    ['wrong anchor type',f=>{f.state.anchor.documentType='SALES_RECEIPT';},'ANCHOR'],
    ['guide type as anchor',f=>{f.state.anchor.documentType='DESPATCH_ADVICE';},'ANCHOR'],
    ['foreign anchor',f=>{f.state.anchor.companyId=2;},'ANCHOR'],
    ['wrong anchor point',f=>{f.state.anchor.emissionPointId=guideUuid(99);},'ANCHOR'],
    ['inactive draft series',f=>{f.state.draftSeries.active=false;},'DRAFT_SERIES'],
    ['draft type 31',f=>{f.state.draftSeries.guideType='31';},'DRAFT_SERIES'],
    ['wrong draft point',f=>{f.state.draftSeries.pointId=guideUuid(99);},'DRAFT_SERIES'],
    ['wrong draft purpose',f=>{f.state.draftSeries.purpose='LOCAL_CANDIDATE';},'DRAFT_SERIES'],
    ['non T draft label',f=>{f.state.draftSeries.label='V001';},'DRAFT_SERIES'],
    ['inactive mapping',f=>{f.state.mapping.active=false;},'SERIES_MAPPING'],
    ['foreign mapping',f=>{f.state.mapping.companyId=2;},'SERIES_MAPPING'],
    ['wrong mapped fiscal ID',f=>{f.state.mapping.fiscalSeriesId=guideUuid(99);},'SERIES_MAPPING'],
    ['wrong mapping purpose',f=>{f.state.mapping.purpose='DRAFT_ONLY';},'SERIES_MAPPING'],
    ['zero mapping revision',f=>{f.state.mapping.revision=0;},'SERIES_MAPPING'],
    ['inactive fiscal counter',f=>{f.state.counter.active=false;},'COUNTER'],
    ['invoice fiscal counter',f=>{f.state.counter.documentType='INVOICE';},'COUNTER'],
    ['foreign fiscal counter',f=>{f.state.counter.companyId=2;},'COUNTER'],
    ['wrong fiscal point',f=>{f.state.counter.emissionPointId=guideUuid(99);},'COUNTER'],
    ['non T fiscal label',f=>{f.state.counter.series='F001';},'COUNTER'],
    ['mismatching fiscal label',f=>{f.state.counter.series='T002';},'COUNTER'],
    ['zero fiscal revision',f=>{f.state.counter.masterRevision=0;},'COUNTER'],
  ];
  it.each(invalidMasters)('rejects %s',async(_,change,part)=>{
    const f=await fixture();change(f);await denied(f,`GUIDE_ISSUE_${part}_INVALID`);
  });
  it.each([
    ['CompanySettings','ISSUER'],['Branch','BRANCH'],['EmissionPoint','POINT'],['SeriesCounter','ANCHOR'],
    ['B2bGuideDraftSeries','DRAFT_SERIES'],['B2bGuideIssueSeries','SERIES_MAPPING'],
  ])('fails closed on absent %s',async(table,part)=>{
    const f=await fixture();f.state.missing.add(table);await denied(f,`GUIDE_ISSUE_${part}_INVALID`);
  });
  it('accepts the exact 03 anchor mapping only with SALES_RECEIPT',async()=>{
    const f=await fixture();f.binding.draft.anchor.documentType='03';f.state.anchor.documentType='SALES_RECEIPT';
    expect((await f.prepare()).counter.series).toBe('T001');f.clean();
  });
  it.each(['anchor','draft'])('rejects fiscal ID reused from %s before SQL',async source=>{
    const f=await fixture();f.binding.fiscalSeriesId=source==='anchor'?f.binding.draft.anchor.seriesId:f.binding.draft.guideSeriesId;
    await denied(f,'INVALID_GUIDE_ISSUE_BINDING',400);expect(f.calls).toHaveLength(0);
  });
  it('rejects 31 and mismatched draft scope before SQL',async()=>{
    const f=await fixture();f.binding.draft.guideType='31';await denied(f,'GUIDE_ISSUE_PROFILE_NOT_ENABLED');
    f.binding.draft.guideType='09';f.draft.binding=structuredClone(f.binding.draft);f.draft.binding.anchor.pointId=guideUuid(99);
    await denied(f,'GUIDE_ISSUE_DRAFT_INVALID');expect(f.calls).toHaveLength(0);
  });
  it.each(['DRAFT','CANCELLED'])('rejects %s state before SQL',async state=>{
    const f=await fixture();f.draft.state=state as GuideDraft['state'];await denied(f,'GUIDE_ISSUE_DRAFT_INVALID');expect(f.calls).toHaveLength(0);
  });
  it.each(['body hash','transport','reason','regulated','items'])('uses genuine local 09/private02/reason04 preparation for %s',async field=>{
    const f=await fixture();
    if(field==='transport')(f.draft.body.transport as Row).mode='01';
    if(field==='reason')f.draft.body.reasonCode='01';
    if(field==='regulated')f.draft.body.regulatedGoods=true;
    if(field==='items')f.draft.body.items=[];
    if(field!=='body hash')f.draft.bodySha256=fiscalSnapshotSha256(f.draft.body);else f.draft.bodySha256='a'.repeat(64);
    await denied(f,'GUIDE_ISSUE_PROFILE_INVALID');
  });
  it.each([
    ['B2bGuideEstablishmentHead','ESTABLISHMENT_REGISTRY_REQUIRED'],['B2bGuideGoodsHead','GUIDE_GOODS_POLICY_REQUIRED'],
  ])('requires existing %s; does not invent configuration',async(table,code)=>{
    const f=await fixture();f.state.missing.add(table);await denied(f,code);
  });
  it('uses actual strict establishment mapping and branch fingerprints',async()=>{
    const f=await fixture();f.state.branches[1].masterRevision++;
    await denied(f,'ESTABLISHMENT_BRANCH_REVISION_CONFLICT');
  });
  it('validates genuine payload SHA rather than trusting head booleans',async()=>{
    const f=await fixture();f.state.establishments.sha256='a'.repeat(64);
    await denied(f,'ESTABLISHMENT_REGISTRY_INCONSISTENT');
  });
  it('validates current goods payload SHA and classification through the real goods guard',async()=>{
    const f=await fixture();f.state.goods.entries[0].classification='REGULATED';f.state.goods=signed(f.state.goods);
    await denied(f,'GUIDE_GOODS_CLASSIFICATION_NOT_ENABLED');
  });
  it('rejects stale goods/product fingerprints on initial validation',async()=>{
    const f=await fixture();f.state.product.description='CAMBIO FICTICIO';await denied(f,'GUIDE_GOODS_PRODUCT_CHANGED');
  });
  it('checks products again before return, while still inside the caller SQL transaction',async()=>{
    const f=await fixture();let reads=0;
    f.control.before=call=>{if(call.sql.includes('FROM "FuelProduct"')&&++reads===2)f.state.product.active=false;};
    await denied(f,'GUIDE_GOODS_PRODUCT_CHANGED');expect(reads).toBe(2);
  });
  it('checks registry freshness again before return',async()=>{
    const f=await fixture();let reads=0;
    f.control.before=call=>{if(call.sql.includes('FROM "B2bGuideEstablishmentHead"')&&++reads===2){
      f.state.establishments.revision++;f.state.establishments=signed(f.state.establishments);
    }};
    await denied(f,'ESTABLISHMENT_MAPPING_CHANGED');expect(reads).toBe(2);
  });
  it('rechecks mapping and counter before returning, without writes',async()=>{
    const f=await fixture();let reads=0;
    f.control.before=call=>{if(call.sql.includes('FROM "SeriesCounter"')&&call.sql.includes('"nextNumber"')&&++reads===2)f.state.counter.nextNumber++;};
    await denied(f,'GUIDE_ISSUE_CONTEXT_CHANGED');expect(reads).toBe(2);
  });
  it.each(['establishments','goods'])('includes current %s head revision and SHA, not only eligibility',async registry=>{
    const f=await fixture(),before=await f.prepare();
    if(registry==='establishments'){
      f.state.establishments.authRevision++;f.state.establishments=signed(f.state.establishments);
    }else{f.state.goods.entries[0].rationale+=' ACTUALIZADA';f.state.goods=signed(f.state.goods);}
    const payloadChanged=await f.prepare();expect(payloadChanged.contextSha256).not.toBe(before.contextSha256);
    if(registry==='establishments'){f.state.establishments.revision++;f.state.establishments=signed(f.state.establishments);}
    else{f.state.goods.revision++;f.state.goods=signed(f.state.goods);}
    expect((await f.prepare()).contextSha256).not.toBe(payloadChanged.contextSha256);f.clean();
  });
  it.each(['issuer','branch','point','anchor','draftSeries','mapping','counter','nextNumber'])('context hash binds %s metadata and revisions',async field=>{
    const f=await fixture(),before=await f.prepare();
    switch(field){
      case 'issuer':
        f.state.company.configVersion++;
        f.state.establishments.issuerRevision=f.state.company.configVersion;f.state.establishments=signed(f.state.establishments);
        f.state.goods.issuerRevision=f.state.company.configVersion;f.state.goods=signed(f.state.goods);break;
      case 'branch':
        f.state.branches[0].masterRevision++;f.state.establishments.entries[0].branchRevision++;
        f.state.establishments=signed(f.state.establishments);break;
      case 'point':f.state.point.masterRevision++;break;
      case 'anchor':f.state.anchor.masterRevision++;break;
      case 'draftSeries':f.state.draftSeries.revision++;break;
      case 'mapping':f.state.mapping.revision++;break;
      case 'counter':f.state.counter.masterRevision++;break;
      case 'nextNumber':f.state.counter.nextNumber++;break;
    }
    expect((await f.prepare()).contextSha256).not.toBe(before.contextSha256);f.clean();
  });
  it('is deterministic for equivalent bigint/string counter representation',async()=>{
    const f=await fixture(),first=await f.prepare();(f.state.counter as Row).nextNumber='1';
    expect(await f.prepare()).toEqual(first);f.clean();
  });
  it('sanitizes SQL driver errors and never retries inside the caller transaction',async()=>{
    const f=await fixture(),detail='SYNTHETIC_SQL_DETAIL_NEVER_EXPOSE';
    f.control.before=()=>{throw Object.assign(new Error(detail),{code:'40001'});};
    const error=await denied(f,'GUIDE_ISSUE_CONTEXT_UNAVAILABLE',503);
    expect(String(error)).not.toContain(detail);expect(f.calls).toHaveLength(1);
  });
  it.each(['establishments','goods'])('validation-only %s helper rejects all admin writes, quota writes and foreign scope',async kind=>{
    const sql:GuideEstablishmentSql={$queryRawUnsafe:vi.fn(),$executeRawUnsafe:vi.fn()};
    const store=kind==='establishments'?transactionBoundGuideEstablishmentStore(sql,1):transactionBoundGuideGoodsStore(sql,1);
    await expect(store.rate('a'.repeat(64),1,1)).rejects.toMatchObject({status:403,code:'GUIDE_ISSUE_VALIDATION_ONLY'});
    await expect(store.transaction(1,tx=>tx.save(null as never,0))).rejects.toMatchObject({status:403,code:'GUIDE_ISSUE_VALIDATION_ONLY'});
    await expect(store.transaction(1,tx=>tx.audit(null as never))).rejects.toMatchObject({status:403,code:'GUIDE_ISSUE_VALIDATION_ONLY'});
    await expect(store.transaction(2,async()=>null)).rejects.toBeInstanceOf(B2bSecurityError);
    expect(sql.$queryRawUnsafe).not.toHaveBeenCalled();expect(sql.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
