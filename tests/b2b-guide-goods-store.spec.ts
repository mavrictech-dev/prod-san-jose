import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {PostgresGuideGoodsStore} from '../services/billing-service/src/b2b/guide-goods-store';
import type {GuideEstablishmentDatabase,GuideEstablishmentSql} from '../services/billing-service/src/b2b/guide-establishment-store';
import type {GuideGoodsAudit,GuideGoodsSnapshot,GuideGoodsTransaction} from '../services/billing-service/src/b2b/guide-goods-types';

// Adapter contracts only: no pg/Prisma client, SQL execution, DDL or core validation.
const companyId=73,otherCompanyId=74;
const uuid=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at='2026-10-22T05:00:00.000Z';
const snapshot=(revision=1):GuideGoodsSnapshot=>({
  schemaVersion:'factuez.guide-goods-policy.v1',companyId,issuerRuc:'20123456789',issuerRevision:2,
  revision,catalogue:{schemaVersion:'factuez.guide-reference-catalogue.v1',version:'synthetic-v1',
    sourceUrl:'https://www.sunat.gob.pe/synthetic-reference',sourceSha256:'c'.repeat(64),
    units:['NIU'],weightUnits:['KGM'],ubigeos:['150101'],referenceStatus:'LOCAL_REFERENCE_NOT_OFFICIAL',sha256:'d'.repeat(64)},
  entries:[{productId:uuid(1),productSha256:'e'.repeat(64),classification:'NON_REGULATED',rationale:"Synthetic ' declaration"}],
  actorId:uuid(2),authRevision:4,at,source:'ADMIN_LOCAL_CONFIGURATION',sha256:'a'.repeat(64),
});
const audit=(action:'READ'|'REPLACE'='REPLACE'):GuideGoodsAudit=>({
  id:uuid(3),requestId:uuid(4),peerSha256:'b'.repeat(64),companyId,revision:1,actorId:uuid(2),action,at,
});
const headRow=(payload=snapshot())=>({headCompanyId:companyId,headRevision:payload.revision,
  versionCompanyId:companyId,versionRevision:payload.revision,payload});
type Call={kind:'query'|'execute';sql:string;values:unknown[]};
type Step={kind:Call['kind'];match:RegExp;result?:unknown;error?:unknown;run?:()=>Promise<unknown>};
const query=(match:RegExp,result:unknown=[]):Step=>({kind:'query',match,result});
const execute=(match:RegExp,result=1):Step=>({kind:'execute',match,result});
const lock=()=>query(/pg_advisory_xact_lock/);
const readHead=(rows:unknown[]=[]):Step=>query(/FROM "B2bGuideGoodsHead" h/,rows);
const insertHead=()=>execute(/INSERT INTO "B2bGuideGoodsHead"/);
const insertVersion=()=>execute(/INSERT INTO "B2bGuideGoodsVersion"/);
const insertAudit=()=>execute(/INSERT INTO "B2bGuideGoodsAudit"/);
const rateQuery=(rows:unknown[]=[]):Step=>query(/INSERT INTO "B2bGuideGoodsRate"/,rows);
const unavailable={status:503,code:'GUIDE_GOODS_STORE_UNAVAILABLE',message:'GUIDE_GOODS_STORE_UNAVAILABLE'};
const conflict={status:409,code:'GUIDE_GOODS_REVISION_CONFLICT'};
const inconsistent={status:409,code:'GUIDE_GOODS_POLICY_INCONSISTENT'};
const sensitive='synthetic-sensitive-driver-detail';
const serializations=[
  {code:'P2034'}, {code:'40001'}, {code:'P2010',meta:{code:'40001'}},
  {code:'P2010',meta:{driverAdapterError:{cause:{originalCode:'40001'}}}},
  {code:'P2010',meta:{driverAdapterError:{cause:{code:'40001'}}}},
];

function fixture(script:Step[]=[],commitErrors:unknown[]=[]) {
  const steps=[...script],errors=[...commitErrors],calls:Call[]=[],committedWrites:Call[]=[];
  let commits=0,rollbacks=0,pending:Call[]=[];
  const request=async(kind:Call['kind'],sql:string,values:unknown[])=>{
    const call={kind,sql:sql.replace(/\s+/g,' ').trim(),values};calls.push(call);
    const step=steps.shift();
    expect(step,`Unexpected ${kind}: ${call.sql}`).toBeDefined();
    if(!step)throw new Error('Unexpected mock SQL');
    expect(kind).toBe(step.kind);expect(call.sql).toMatch(step.match);
    if('error' in step)throw step.error;
    const result=step.run?await step.run():step.result;
    if(kind==='execute')pending.push(call);
    return result;
  };
  const sql:GuideEstablishmentSql={
    $queryRawUnsafe:vi.fn(async<T=unknown>(text:string,...values:unknown[])=>await request('query',text,values) as T),
    $executeRawUnsafe:vi.fn(async(text:string,...values:unknown[])=>await request('execute',text,values) as number),
  };
  const transaction=vi.fn(async<T>(work:(tx:GuideEstablishmentSql)=>Promise<T>,_options:Parameters<GuideEstablishmentDatabase['$transaction']>[1])=>{
    pending=[];
    try{
      const result=await work(sql);
      if(errors.length)throw errors.shift();
      committedWrites.push(...pending);commits++;return result;
    }catch(error){rollbacks++;throw error;}finally{pending=[];}
  });
  const db:GuideEstablishmentDatabase={$transaction:transaction};
  const store=new PostgresGuideGoodsStore(db);
  return{store,sql,transaction,calls,committedWrites,get commits(){return commits;},get rollbacks(){return rollbacks;},
    done(){
      expect(steps).toHaveLength(0);
      for(const call of calls){
        const slots=[...new Set([...call.sql.matchAll(/\$(\d+)\b/g)].map(m=>Number(m[1])))].sort((a,b)=>a-b);
        expect(slots).toEqual(call.values.map((_,i)=>i+1));
        for(const value of call.values.flat())if(typeof value==='string')expect(call.sql).not.toContain(value);
        expect(call.sql).not.toMatch(/SELECT\s+\*|\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i);
      }
    }};
}
async function denied(promise:Promise<unknown>,expected:{status:number;code:string;message?:string}=unavailable){
  const error=await promise.then(()=>null,error=>error);
  expect(error).toBeInstanceOf(B2bSecurityError);expect(error).toMatchObject(expected);
  expect(String(error)).not.toContain(sensitive);expect(error.cause).toBeUndefined();
  return error;
}

describe('PostgresGuideGoodsStore: isolated adapter contracts (39 checks)',()=>{
  it('01 constructs the public store without queries or transactions',()=>{
    const f=fixture();expect(f.store).toBeInstanceOf(PostgresGuideGoodsStore);
    expect(f.transaction).not.toHaveBeenCalled();expect(f.calls).toEqual([]);f.done();
  });
  it('02 awaits the company advisory lock before callback with exact Serializable options',async()=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const f=fixture([{...lock(),run:async()=>{await gate;return [];}}]);
    const callback=vi.fn(async()=>42),result=f.store.transaction(companyId,callback);
    await Promise.resolve();expect(callback).not.toHaveBeenCalled();
    expect(f.calls[0].values).toEqual(['factuez:guide-goods:'+companyId]);
    expect(f.calls[0].sql).toContain('hashtextextended($1,0)');
    expect(f.transaction.mock.calls[0][1]).toEqual({isolationLevel:'Serializable',timeout:15000,maxWait:3000});
    release();expect(await result).toBe(42);expect(callback).toHaveBeenCalledTimes(1);expect(f.commits).toBe(1);f.done();
  });
  it('03 sanitizes lock failure and never invokes callback',async()=>{
    const f=fixture([{...lock(),error:new Error(sensitive)}]),callback=vi.fn(async()=>42);
    await denied(f.store.transaction(companyId,callback));expect(callback).not.toHaveBeenCalled();
    expect(f.commits).toBe(0);expect(f.rollbacks).toBe(1);f.done();
  });
  it('04 parameterizes company id, selects active BETA metadata and locks it',async()=>{
    const row={id:companyId,ruc:'20123456789',environment:'BETA',configVersion:2,active:true};
    const f=fixture([lock(),query(/FROM "CompanySettings"/,[row])]);
    expect(await f.store.transaction(companyId,tx=>tx.company(companyId))).toEqual(row);
    expect(f.calls[1].values).toEqual([companyId]);
    expect(f.calls[1].sql).toMatch(/^SELECT "id","ruc","environment","configVersion","active"/);
    expect(f.calls[1].sql).toContain('WHERE "id"=$1 AND "active"=true AND "environment"=\'BETA\' FOR UPDATE');f.done();
  });
  it('05 queries exactly the shared product allowlist with no inferred tenant or active filter',async()=>{
    const rows=[{id:uuid(1),sku:'SYNTHETIC',description:'Synthetic product',category:'SYNTHETIC',
      unitCode:'NIU',sunatProductCode:null,active:false,updatedAt:at}];
    const ids=[uuid(1),"untrusted'); SELECT secret; --"];
    const f=fixture([lock(),query(/FROM "FuelProduct"/,rows),query(/FROM "FuelProduct"/,[])]);
    await f.store.transaction(companyId,async tx=>{
      expect(await tx.products(ids)).toEqual(rows);expect(await tx.products([])).toEqual([]);
    });
    expect(f.calls[1].values).toEqual([ids]);expect(f.calls[2].values).toEqual([[]]);
    expect(f.calls[1].sql).toBe('SELECT "id","sku","description","category","unitCode","sunatProductCode","active","updatedAt" FROM "FuelProduct" WHERE "id"=ANY($1::uuid[]) ORDER BY "id" FOR SHARE');
    expect(f.calls[1].sql).not.toMatch(/companyId|defaultUnitPrice|taxAffectationCode|AND "active"/);f.done();
  });
  it('06 joins head and version by both physical identities and locks only the head',async()=>{
    const p=snapshot(),f=fixture([lock(),readHead([headRow(p)])]);
    expect(await f.store.transaction(companyId,tx=>tx.head(companyId))).toBe(p);
    expect(f.calls[1].values).toEqual([companyId]);
    expect(f.calls[1].sql).toContain('v."companyId"=h."companyId" AND v."revision"=h."revision"');
    expect(f.calls[1].sql).toContain('WHERE h."companyId"=$1 FOR UPDATE OF h');f.done();
  });
  it('07 returns null for absent company metadata or an absent head',async()=>{
    const f=fixture([lock(),query(/FROM "CompanySettings"/,[]),readHead()]);
    await f.store.transaction(companyId,async tx=>{
      expect(await tx.company(companyId)).toBeNull();expect(await tx.head(companyId)).toBeNull();
    });f.done();
  });
  it('08 rejects mismatched physical head/version identities, revisions or duplicate rows',async()=>{
    const valid=headRow();
    for(const rows of [
      [{...valid,headCompanyId:otherCompanyId}],[{...valid,versionCompanyId:otherCompanyId}],
      [{...valid,versionRevision:2}],[{...valid,headRevision:0}],[{...valid,headRevision:1.5}],
      [{...valid,headRevision:2147483648}],[{...valid,versionCompanyId:null,versionRevision:null,payload:null}],[valid,valid],
    ]){
      const f=fixture([lock(),readHead(rows)]);
      await denied(f.store.transaction(companyId,tx=>tx.head(companyId)),inconsistent);expect(f.commits).toBe(0);f.done();
    }
  });
  it('09 rejects JSON identity/revision mismatches and nonobject payloads',async()=>{
    for(const payload of [null,[],false,'json',{companyId:otherCompanyId,revision:1},{companyId,revision:2},{companyId:String(companyId),revision:1}]){
      const f=fixture([lock(),readHead([{...headRow(),payload}])]);
      await denied(f.store.transaction(companyId,tx=>tx.head(companyId)),inconsistent);f.done();
    }
  });
  it('10 binds every transaction port to the locked company before issuing SQL',async()=>{
    const operations:((tx:GuideGoodsTransaction)=>Promise<unknown>)[]=[
      tx=>tx.company(otherCompanyId),tx=>tx.head(otherCompanyId),
      tx=>tx.save({...snapshot(),companyId:otherCompanyId},0),tx=>tx.audit({...audit(),companyId:otherCompanyId}),
    ];
    for(const operation of operations){
      const f=fixture([lock()]);await denied(f.store.transaction(companyId,operation),inconsistent);
      expect(f.calls).toHaveLength(1);expect(f.commits).toBe(0);f.done();
    }
  });
  it('11 rejects invalid company bounds before opening a transaction',async()=>{
    for(const id of [0,-1,1.5,NaN,Infinity,2147483648,'73',null]){
      const f=fixture();await denied(f.store.transaction(id as number,async()=>true));expect(f.transaction).not.toHaveBeenCalled();f.done();
    }
  });
  it('12 CAS-inserts the first head before appending the immutable version',async()=>{
    const p=snapshot(),f=fixture([lock(),readHead(),insertHead(),insertVersion()]);
    await f.store.transaction(companyId,tx=>tx.save(p,0));
    expect(f.calls[2].sql).toContain('ON CONFLICT ("companyId") DO NOTHING');expect(f.calls[2].values).toEqual([companyId,1]);
    expect(f.calls[3].values).toEqual([companyId,1,JSON.stringify(p)]);
    expect(f.calls[3].sql).toContain('VALUES ($1,$2,$3::jsonb)');expect(f.committedWrites).toHaveLength(2);f.done();
  });
  it('13 updates the head with exact expected revision and appends revision plus one',async()=>{
    const p=snapshot(3),f=fixture([lock(),readHead([headRow(snapshot(2))]),execute(/UPDATE "B2bGuideGoodsHead"/),insertVersion()]);
    await f.store.transaction(companyId,tx=>tx.save(p,2));
    expect(f.calls[2].sql).toContain('SET "revision"=$2 WHERE "companyId"=$1 AND "revision"=$3');
    expect(f.calls[2].values).toEqual([companyId,3,2]);expect(f.calls[3].values).toEqual([companyId,3,JSON.stringify(p)]);f.done();
  });
  it('14 rejects a stale expected head, including nonexistent and already initialized registries',async()=>{
    for(const [expected,rows] of [[1,[]],[0,[headRow()]],[1,[headRow(snapshot(2))]]] as const){
      const f=fixture([lock(),readHead([...rows])]);
      await denied(f.store.transaction(companyId,tx=>tx.save(snapshot(expected+1),expected)),conflict);
      expect(f.sql.$executeRawUnsafe).not.toHaveBeenCalled();f.done();
    }
  });
  it('15 rejects invalid expected revisions, overflow and nonconsecutive snapshots before writes',async()=>{
    for(const [expected,next] of [[-1,0],[1.5,2.5],[NaN,1],[2147483647,2147483648],[0,2],[2,2]]){
      const f=fixture([lock()]);await denied(f.store.transaction(companyId,tx=>tx.save(snapshot(next),expected)),conflict);
      expect(f.calls).toHaveLength(1);f.done();
    }
  });
  it('16 reports 409 when either first-insert or update CAS affects zero rows',async()=>{
    for(const expected of [0,1]){
      const f=fixture([lock(),readHead(expected?[headRow()]:[]),execute(expected?/UPDATE "B2bGuideGoodsHead"/:/INSERT INTO "B2bGuideGoodsHead"/,0)]);
      await denied(f.store.transaction(companyId,tx=>tx.save(snapshot(expected+1),expected)),conflict);
      expect(f.calls).toHaveLength(3);expect(f.committedWrites).toEqual([]);f.done();
    }
  });
  it('17 rolls back the head when the version append reports no inserted row',async()=>{
    const f=fixture([lock(),readHead(),insertHead(),execute(/INSERT INTO "B2bGuideGoodsVersion"/,0)]);
    await denied(f.store.transaction(companyId,tx=>tx.save(snapshot(),0)));expect(f.commits).toBe(0);expect(f.committedWrites).toEqual([]);f.done();
  });
  it('18 appends only explicit audit fields, including request and actor ids, without extra secrets',async()=>{
    for(const action of ['READ','REPLACE'] as const){
      const value={...audit(action),token:sensitive,peer:'raw-peer',secret:sensitive,authority:{credential:sensitive}};
      const f=fixture([lock(),insertAudit()]);await f.store.transaction(companyId,tx=>tx.audit(value));
      expect(f.calls[1].sql).toContain('("id","requestId","peerSha256","companyId","revision","actorId","action","at")');
      expect(f.calls[1].values).toEqual([value.id,value.requestId,value.peerSha256,companyId,1,value.actorId,action,at]);
      expect(JSON.stringify(f.calls)).not.toContain(sensitive);expect(JSON.stringify(f.calls)).not.toContain('raw-peer');
      expect(f.committedWrites).toHaveLength(1);f.done();
    }
  });
  it('19 emits a parameterized atomic rate UPSERT with forward-only reset and saturating denied counter',async()=>{
    const f=fixture([rateQuery([{allowed:true}])]);expect(await f.store.rate('c'.repeat(64),100,30)).toBe(true);
    const call=f.calls[0];expect(call.values).toEqual(['c'.repeat(64),100,30]);
    expect(call.sql).toContain('ON CONFLICT ("keyHash") DO UPDATE');
    expect(call.sql).toContain('CASE WHEN EXCLUDED."window">r."window" THEN 1');
    expect(call.sql).toContain('LEAST(r."counter"::bigint+1,2147483647)::integer');
    expect(call.sql).toContain('WHERE EXCLUDED."window">=r."window"');
    expect(call.sql).toContain('"counter"<=$3::integer');
    expect(f.transaction.mock.calls[0][1]).toEqual({isolationLevel:'Serializable',timeout:15000,maxWait:3000});f.done();
  });
  it('20 returns allowed/denied quota decisions and fails closed on a backwards-window no-op',async()=>{
    const f=fixture([rateQuery([{allowed:true}]),rateQuery([{allowed:false}]),rateQuery([])]);
    expect(await f.store.rate('c'.repeat(64),100,30)).toBe(true);
    expect(await f.store.rate('c'.repeat(64),100,30)).toBe(false);
    expect(await f.store.rate('c'.repeat(64),99,30)).toBe(false);expect(f.calls[2].values).toEqual(['c'.repeat(64),99,30]);f.done();
  });
  it('21 rejects invalid rate hash, window and limit bounds without database access',async()=>{
    const key='c'.repeat(64);
    for(const [hash,window,limit] of [
      ['bad',1,30],['C'.repeat(64),1,30],[key+'\n',1,30],[key+'\r\n',1,30],[null,1,30],[key,-1,30],[key,1.5,30],[key,NaN,30],
      [key,Infinity,30],[key,Number.MAX_SAFE_INTEGER+1,30],[key,1,0],[key,1,-1],
      [key,1,1.5],[key,1,2147483647],[key,1,2147483648],[key,1,NaN],
    ]){
      const f=fixture();await denied(f.store.rate(hash as string,window as number,limit as number));
      expect(f.transaction).not.toHaveBeenCalled();f.done();
    }
  });
  it('22 accepts inclusive valid window and limit extremes as bound parameters',async()=>{
    for(const [window,limit] of [[0,1],[Number.MAX_SAFE_INTEGER,2147483646]]){
      const f=fixture([rateQuery([{allowed:true}])]);expect(await f.store.rate('c'.repeat(64),window,limit)).toBe(true);
      expect(f.calls[0].values).toEqual(['c'.repeat(64),window,limit]);f.done();
    }
  });
  it('23 sanitizes malformed rate decision rows',async()=>{
    for(const rows of [[{allowed:'true'}],[{}],[{allowed:true},{allowed:false}]]){
      const f=fixture([rateQuery(rows)]);await denied(f.store.rate('c'.repeat(64),1,30));expect(f.commits).toBe(0);f.done();
    }
  });
  it('24 retries only supported serialization codes and succeeds on the third whole callback',async()=>{
    for(const error of serializations){
      const f=fixture([lock(),lock(),lock()],[error,error]),callback=vi.fn(async()=>42);
      expect(await f.store.transaction(companyId,callback)).toBe(42);
      expect(callback).toHaveBeenCalledTimes(3);expect(f.transaction).toHaveBeenCalledTimes(3);
      expect(f.calls.every(c=>c.sql.includes('pg_advisory_xact_lock'))).toBe(true);
      expect(f.commits).toBe(1);expect(f.rollbacks).toBe(2);f.done();
    }
  });
  it('25 caps serialization failures at exactly three attempts, then emits safe 503',async()=>{
    for(const error of serializations){
      const f=fixture([lock(),lock(),lock()],[error,error,error]);
      await denied(f.store.transaction(companyId,async()=>42));expect(f.transaction).toHaveBeenCalledTimes(3);
      expect(f.commits).toBe(0);expect(f.rollbacks).toBe(3);f.done();
    }
  });
  it('26 never retries unique violations or serialization-looking messages without exact codes',async()=>{
    for(const error of [
      {code:'23505'},{code:'P2002'},{code:'P2010',meta:{code:'23505'}},
      {code:'P2010',meta:{driverAdapterError:{cause:{originalCode:'23505',originalMessage:'B2bGuideDraftOperation_clientId_actorKey_keySha256_key'}}}},
      {code:'400010'},{code:'40P01'},new Error('40001 P2034'),{code:'P2010',meta:{message:'40001'}},
    ]){
      const f=fixture([lock()],[error]);await denied(f.store.transaction(companyId,async()=>true));
      expect(f.transaction).toHaveBeenCalledTimes(1);f.done();
    }
  });
  it('27 sanitizes unknown driver, callback and commit failures without leaked details',async()=>{
    for(const error of [new Error(sensitive),{code:'UNKNOWN',message:sensitive},sensitive,null,undefined]){
      const f=fixture([lock()],[error]);await denied(f.store.transaction(companyId,async()=>true));
      expect(f.transaction).toHaveBeenCalledTimes(1);f.done();
    }
    const f=fixture([lock()]);await denied(f.store.transaction(companyId,async()=>{throw new Error(sensitive);}));f.done();
  });
  it('28 preserves B2bSecurityError instances without wrapping or retrying in both public ports',async()=>{
    const error=new B2bSecurityError(409,'GUIDE_GOODS_REVISION_CONFLICT');
    const f=fixture([lock()]);expect(await denied(f.store.transaction(companyId,async()=>{throw error;}),conflict)).toBe(error);
    expect(f.transaction).toHaveBeenCalledTimes(1);f.done();
    const rate=fixture([rateQuery([{allowed:true}])],[error]);
    expect(await denied(rate.store.rate('c'.repeat(64),1,30),conflict)).toBe(error);
    expect(rate.transaction).toHaveBeenCalledTimes(1);rate.done();
  });
  it('29 rolls back successful head/version writes if a later audit SQL statement fails',async()=>{
    const f=fixture([lock(),readHead(),insertHead(),insertVersion(),{...insertAudit(),error:new Error(sensitive)}]);
    await denied(f.store.transaction(companyId,async tx=>{await tx.save(snapshot(),0);await tx.audit(audit());}));
    expect(f.commits).toBe(0);expect(f.rollbacks).toBe(1);expect(f.committedWrites).toEqual([]);f.done();
  });
  it('30 poisons a callback that swallows a failed version write and returns success',async()=>{
    const f=fixture([lock(),readHead(),insertHead(),{...insertVersion(),error:new Error(sensitive)}]);
    let returned=false;
    await denied(f.store.transaction(companyId,async tx=>{
      try{await tx.save(snapshot(),0);}catch{}returned=true;return 'pretend success';
    }));
    expect(returned).toBe(true);expect(f.commits).toBe(0);expect(f.rollbacks).toBe(1);expect(f.committedWrites).toEqual([]);f.done();
  });
  it('31 preserves the poisoned SQL failure when callback masks it with a business conflict',async()=>{
    const f=fixture([lock(),readHead(),insertHead(),{...insertVersion(),error:{code:'23505',message:sensitive}}]);
    await denied(f.store.transaction(companyId,async tx=>{
      try{await tx.save(snapshot(),0);}catch{}throw new B2bSecurityError(409,'MASKED_FAILURE');
    }));
    expect(f.transaction).toHaveBeenCalledTimes(1);expect(f.commits).toBe(0);expect(f.committedWrites).toEqual([]);f.done();
  });
  it('32 blocks subsequent ports and commit after a swallowed audit write failure',async()=>{
    const failure=new Error(sensitive);
    const f=fixture([lock(),readHead(),insertHead(),insertVersion(),{...insertAudit(),error:failure}]);
    await denied(f.store.transaction(companyId,async tx=>{
      await tx.save(snapshot(),0);try{await tx.audit(audit());}catch{}
      await expect(tx.company(companyId)).rejects.toBe(failure);
      await expect(tx.audit(audit())).rejects.toBe(failure);return true;
    }));
    expect(f.calls).toHaveLength(5);expect(f.commits).toBe(0);expect(f.rollbacks).toBe(1);expect(f.committedWrites).toEqual([]);f.done();
  });

  it('33 normalizes driver Dates and offset timestamps before the core fingerprints metadata',async()=>{
    const base={id:uuid(1),sku:'SYNTHETIC',description:'Synthetic product',category:'SYNTHETIC',
      unitCode:'NIU',sunatProductCode:null,active:true};
    for(const updatedAt of [new Date(at),at,'2026-10-22T00:00:00-05:00']){
      const f=fixture([lock(),query(/FROM "FuelProduct"/,[{...base,updatedAt}])]);
      expect(await f.store.transaction(companyId,tx=>tx.products([uuid(1)]))).toEqual([{...base,updatedAt:at}]);f.done();
    }
  });
  it('34 rejects invalid product timestamps and poisons subsequent operations',async()=>{
    for(const updatedAt of [new Date(NaN),'invalid',null,undefined,123]){
      const f=fixture([lock(),query(/FROM "FuelProduct"/,[{updatedAt}])]);
      await denied(f.store.transaction(companyId,async tx=>{
        await expect(tx.products([uuid(1)])).rejects.toMatchObject(inconsistent);
        await expect(tx.head(companyId)).rejects.toMatchObject(inconsistent);return true;
      }),inconsistent);
      expect(f.calls).toHaveLength(2);expect(f.commits).toBe(0);f.done();
    }
  });
  it('35 returns only allowed metadata even when a driver row includes unrelated properties',async()=>{
    const base={id:uuid(1),sku:'SYNTHETIC',description:'Synthetic product',category:'SYNTHETIC',
      unitCode:'NIU',sunatProductCode:null,active:false,updatedAt:at};
    const f=fixture([lock(),query(/FROM "FuelProduct"/,[{...base,defaultUnitPrice:sensitive,taxAffectationCode:sensitive}])]);
    const rows=await f.store.transaction(companyId,tx=>tx.products([uuid(1)]));
    expect(rows).toEqual([base]);expect(JSON.stringify(rows)).not.toContain(sensitive);f.done();
  });
  it('36 retries a swallowed serialization failure using a fresh unpoisoned transaction',async()=>{
    const f=fixture([lock(),{...query(/FROM "FuelProduct"/),error:{code:'40001'}},lock(),query(/FROM "FuelProduct"/,[])]);
    const callback=vi.fn(async(tx:GuideGoodsTransaction)=>{try{return await tx.products([]);}catch{return [];}});
    expect(await f.store.transaction(companyId,callback)).toEqual([]);
    expect(callback).toHaveBeenCalledTimes(2);expect(f.rollbacks).toBe(1);expect(f.commits).toBe(1);f.done();
  });
  it('37 applies the same serialization-only retry boundary to quota decisions',async()=>{
    for(const error of serializations){
      const f=fixture([rateQuery([{allowed:true}]),rateQuery([{allowed:false}])],[error]);
      expect(await f.store.rate('c'.repeat(64),100,30)).toBe(false);
      expect(f.transaction).toHaveBeenCalledTimes(2);f.done();
    }
    const f=fixture([{...rateQuery(),error:{code:'40P01',message:sensitive}}]);
    await denied(f.store.rate('c'.repeat(64),100,30));expect(f.transaction).toHaveBeenCalledTimes(1);f.done();
  });
  it('38 keeps DDL a standalone candidate with deferred version membership and independent table names',()=>{
    const ddl=readFileSync(new URL('../services/billing-service/b2b-guide-goods-schema.candidate.sql',import.meta.url),'utf8');
    expect(ddl).toContain('REVIEW CANDIDATE ONLY');
    expect([...ddl.matchAll(/CREATE TABLE "([^"]+)"/g)].map(m=>m[1])).toEqual([
      'B2bGuideGoodsHead','B2bGuideGoodsVersion','B2bGuideGoodsAudit','B2bGuideGoodsRate']);
    expect(ddl).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect((ddl.match(/REFERENCES "CompanySettings"/g)??[])).toHaveLength(3);
    expect(ddl).not.toMatch(/B2bGuideEstablishment|FROM "CompanySettings"|FROM "FuelProduct"|SeriesCounter|nextval|setval/i);
    for(const table of ['Head','Version','Audit','Rate'])
      expect(ddl).toContain('BEFORE TRUNCATE ON "B2bGuideGoods'+table+'"');
    for(const table of ['Version','Audit'])
      expect(ddl).toContain('BEFORE UPDATE OR DELETE ON "B2bGuideGoods'+table+'"');
  });
  it('39 declares bounded explicit payloads, attributable classifications and monotonic counters',()=>{
    const ddl=readFileSync(new URL('../services/billing-service/b2b-guide-goods-schema.candidate.sql',import.meta.url),'utf8');
    for(const contract of ['b2b_guide_goods_payload_valid','jsonb_array_length(p->\'entries\')>200',
      "length(e->>'rationale') NOT BETWEEN 1 AND 500","'NON_REGULATED','REGULATED','UNKNOWN'",
      'GUIDE_GOODS_HEAD_IDENTITY_OR_REVISION','GUIDE_GOODS_VERSION_PREDECESSOR_REQUIRED',
      'GUIDE_GOODS_AUDIT_ACTOR_OR_TIME_MISMATCH','GUIDE_GOODS_RATE_IDENTITY_OR_WINDOW',
      'LEAST(OLD."counter"::bigint+1,2147483647)','9007199254740991'])
      expect(ddl).toContain(contract);
  });

});

