import 'reflect-metadata';
import {createRequire} from 'node:module';
import {beforeAll,afterAll,beforeEach,describe,expect,it} from 'vitest';
import {B2bSecurityError,type B2bPrincipal} from '../packages/contracts/src/b2b-security';
import {receivedSubject,type ReceivedScope} from '../packages/service-access/src/b2b-received-wire';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {B2bReceptionReads} from '../services/received-documents-service/src/b2b/read';
import {PostgresReceivedReadStore,receptionGrantKey,type ReceivedReadTransaction} from '../services/received-documents-service/src/b2b/store';
import {ReceptionService} from '../services/received-documents-service/src/reception.service';
import {createB2bReceivedReadOwner} from '../services/received-documents-service/src/b2b/assembly';
import {receivedXml,receivedCdr} from './received-fixture.mjs';
const require=createRequire(import.meta.url);
const {withReceivedDatabase}=require('./helpers/b2b-received-db.cjs');
if(process.env.FACTUEZ_B2B_RECEIVED_OWNED_DB!=='NEW_NETWORK_NONE_TMPFS_ONLY')throw new Error('EXPLICIT_NEW_DATABASE_RUNNER_REQUIRED');
const id=(n:number)=>`fea80800-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope:ReceivedScope={environment:'BETA',companyId:1,recipientRuc:'00000000101',branchId:id(1)};
const principal:B2bPrincipal={kind:'SERVICE',clientId:id(2),subjectId:null,userAuthRevision:null,revision:1,environment:'BETA',
  scopes:['b2b:received:read','b2b:received:artifacts:read'],bindings:[{issuerId:1,issuerRuc:scope.recipientRuc,environment:'BETA',branchId:scope.branchId,pointId:id(3),seriesId:id(4),documentType:'01'}]};
let db:any,pool:any,store:PostgresReceivedReadStore,owner:B2bReceptionReads,service:ReceptionService;
let release:()=>void,completed:Promise<unknown>;
let identityCalls=0,revoked=false,identityHook:((n:number)=>Promise<void>)|null=null,adminCalls=0,adminHook:((n:number)=>Promise<void>)|null=null;
const access={token:'synthetic-received-owner-token',kind:'SERVICE' as const};
const identity={authenticate:async(token:string,required:string[],kind:'SERVICE'|'USER')=>{
  ++identityCalls;await identityHook?.(identityCalls);
  if(revoked||token!==access.token||kind!==principal.kind||required.some(s=>!principal.scopes.includes(s as any)))throw new B2bSecurityError(403,'SYNTHETIC_IDENTITY_DENIED');
  return structuredClone(principal);
}};
const admin={authorize:async(handle:string,digest:string)=>{
  ++adminCalls;await adminHook?.(adminCalls);
  if(handle!=='synthetic-live-step-up')throw new B2bSecurityError(403,'STEP_UP_REQUIRED');
  return {adminId:id(90),authRevision:1,policySha256:digest};
}};
const policy=(permission:'READ'|'ARTIFACT',active=true,who=receivedSubject(principal),s=scope)=>({scope:s,subject:who,permission,active,clientRevision:1,userAuthRevision:who.kind==='USER'?1:null});
const grant=(permission:'READ'|'ARTIFACT',active=true,expected=0,who=receivedSubject(principal),s=scope)=>owner.setGrant('synthetic-live-step-up',policy(permission,active,who,s),expected);
const query={scope,from:'2026-01-01',to:'2026-01-02',limit:25};
const docs=new Map<string,{id:string;xml:Buffer;artifacts:any[]}>();
const auditCount=async()=>Number((await pool.query('SELECT count(*) AS n FROM "B2bReceivedReadAudit"')).rows[0].n);

beforeAll(async()=>{
  let ready!:()=>void,failed!:(e:unknown)=>void;
  const initialized=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
  const finished=new Promise<void>(resolve=>{release=resolve;});
  completed=withReceivedDatabase(async({client, pool:ownedPool}:any)=>{
    db=client;pool=ownedPool;store=new PostgresReceivedReadStore(client);owner=createB2bReceivedReadOwner({database:client,identity,grantAdministrator:admin});service=new ReceptionService(client);
    const importAccess:any={user:{sub:id(80),scope:{kind:'GLOBAL'}},catalog:{companies:[
      {id:1,ruc:scope.recipientRuc,legalName:'RECEPTOR FICTICIO',environment:'BETA'},
      {id:2,ruc:'00000000202',legalName:'OTRO RECEPTOR FICTICIO',environment:'BETA'},
    ],branches:[{id:scope.branchId,companyId:1},{id:id(10),companyId:1},{id:id(11),companyId:2}]}};
    try{
      async function load(key:string,type:string,number:string,companyId=1,branchId:string|null=scope.branchId,recipient=scope.recipientRuc){
        const xml=Buffer.from(receivedXml(type,number,recipient));
        const result=await service.import(importAccess,{companyId,branchId,files:[{fileName:`00000000303-${type}-${number}.xml`,contentBase64:xml.toString('base64')}]});
        const imported=result.results[0];expect(imported.outcome).toBe('IMPORTED');expect(imported.id).toBeTruthy();
        docs.set(key,{id:imported.id!,xml,artifacts:[]});return imported.id!;
      }
      for(const [type,number] of [['01','FQA1-00000001'],['03','BQA1-00000002'],['07','FQC1-00000003'],['08','FQD1-00000004'],['09','TQA1-00000005'],['31','VQA1-00000006']])await load(type,type,number);
      await load('other-branch','01','FQA1-00000010',1,id(10));
      await load('unassigned','01','FQA1-00000011',1,null);
      await load('other-company','01','FQA1-00000012',2,id(11),'00000000202');
      await service.attach(importAccess,docs.get('01')!.id,{kind:'CDR',fileName:'R-FQA1-00000001.xml',contentBase64:Buffer.from(receivedCdr()).toString('base64')});
      await service.attach(importAccess,docs.get('01')!.id,{kind:'PROVIDER_PDF',fileName:'provider-original.pdf',contentBase64:Buffer.from('%PDF-1.4 SYNTHETIC ONLY').toString('base64')});
      for(const doc of docs.values())doc.artifacts=await db.receivedArtifact.findMany({where:{documentId:doc.id}});
      await grant('READ');await grant('ARTIFACT');ready();await finished;
    }catch(e){failed(e);throw e;}
  });
  void completed.catch(failed);await initialized;
},120000);
afterAll(async()=>{release?.();await completed;},120000);
beforeEach(()=>{identityCalls=0;revoked=false;identityHook=null;adminCalls=0;adminHook=null;});

describe('B2B08 reception owner on NEW labelled network-none tmpfs PostgreSQL',()=>{
  it.each(['01','03','07','08','09','31'])('imports actual fictitious %s XML and exposes whole item decimals and exact original',async type=>{
    const doc=docs.get(type)!,detail:any=await owner.execute(access,'DETAIL',{scope,id:doc.id});
    expect(detail.projection.documentType).toBe(type);expect(detail.projection.items[0]).toMatchObject({quantity:'5.000',unitValue:'20.000000',unitPrice:'23.60'});
    expect(detail.fiscalAcceptance).toBe('NOT_VERIFIED');expect(detail.projection.signature.officialTrust).toBe(false);
    const file:any=await owner.execute(access,'CONTENT',{scope,id:doc.id,artifactId:doc.artifacts.find(a=>a.kind==='XML').id});expect(file.bytes).toEqual(doc.xml);
    expect(await db.receivedItemRecord.count({where:{documentId:doc.id}})).toBe(1);
  });
  it('real SQL membership filters company/RUC/branch, unassigned and keyset pagination',async()=>{
    const first:any=await owner.execute(access,'LIST',{...query,limit:2});expect(first.items).toHaveLength(2);expect(first.page.hasMore).toBe(true);
    const second:any=await owner.execute(access,'LIST',{...query,after:first.page.nextAfter,limit:100});
    const all=[...first.items,...second.items];expect(all).toHaveLength(6);expect(new Set(all.map(r=>r.id)).size).toBe(6);
    expect(all.every(r=>r.companyId===1&&r.recipientRuc===scope.recipientRuc&&r.branchId===scope.branchId)).toBe(true);
    expect((await owner.execute(access,'LIST',{...query,type:'07'}) as any).items).toHaveLength(1);
  });
  it.each(['other-branch','unassigned','other-company'])('does not read %s through a valid but unrelated reception grant',async key=>{
    await expect(owner.execute(access,'DETAIL',{scope,id:docs.get(key)!.id})).rejects.toMatchObject({status:404});
  });
  it.each([{...scope,recipientRuc:'00000000202'},{...scope,companyId:2},{...scope,branchId:id(10)}])('requires Identity anchor for the exact tuple %j',async foreign=>{
    await expect(owner.execute(access,'LIST',{...query,scope:foreign})).rejects.toMatchObject({status:404});
  });
  it('READ and ARTIFACT are independent; neither an emission anchor nor ARTIFACT alone implies READ',async()=>{
    const who={kind:'SERVICE' as const,clientId:id(20),subjectId:null};
    const previous=principal.clientId;principal.clientId=who.clientId;
    try{
      await expect(owner.execute(access,'LIST',query)).rejects.toMatchObject({status:403});
      await grant('ARTIFACT');await expect(owner.execute(access,'ARTIFACTS',{scope,id:docs.get('01')!.id})).rejects.toMatchObject({status:403});
      await grant('READ');expect((await owner.execute(access,'DETAIL',{scope,id:docs.get('01')!.id}) as any).document.id).toBe(docs.get('01')!.id);
      await grant('ARTIFACT',false,1);await expect(owner.execute(access,'ARTIFACTS',{scope,id:docs.get('01')!.id})).rejects.toMatchObject({status:403});
      expect((await owner.execute(access,'LIST',query) as any).items).toHaveLength(6);
    }finally{principal.clientId=previous;}
  });
  it('persists SERVICE with null human identity; USER has its own grant and auth revision',async()=>{
    const serviceAudit=(await pool.query('SELECT "actorKind","subjectId","userAuthRevision" FROM "B2bReceivedReadAudit" ORDER BY "id" LIMIT 1')).rows[0];
    expect(serviceAudit).toEqual({actorKind:'SERVICE',subjectId:null,userAuthRevision:null});
    principal.kind='USER';principal.subjectId=id(21);principal.userAuthRevision=1;
    try{
      await expect(owner.execute({token:access.token,kind:'USER'},'LIST',query)).rejects.toMatchObject({status:403});
      await grant('READ');await owner.execute({token:access.token,kind:'USER'},'LIST',query);
      principal.userAuthRevision=2;await expect(owner.execute({token:access.token,kind:'USER'},'LIST',query)).rejects.toMatchObject({status:403});
      const audit=(await pool.query('SELECT "actorKind","subjectId","userAuthRevision" FROM "B2bReceivedReadAudit" ORDER BY "id" DESC LIMIT 1')).rows[0];
      expect(audit).toEqual({actorKind:'USER',subjectId:id(21),userAuthRevision:1});
    }finally{principal.kind='SERVICE';principal.subjectId=null;principal.userAuthRevision=null;}
  });
  it('requires live exact-digest step-up; CAS keeps one policy version per update',async()=>{
    const who={kind:'SERVICE' as const,clientId:id(22),subjectId:null},p=policy('READ',true,who);
    await expect(new B2bReceptionReads(store,identity).setGrant('x',p,0)).rejects.toMatchObject({status:503});
    await expect(owner.setGrant('wrong-handle',p,0)).rejects.toMatchObject({status:403});
    expect(await owner.setGrant('synthetic-live-step-up',p,0)).toEqual({revision:1,active:true});
    await expect(owner.setGrant('synthetic-live-step-up',p,0)).rejects.toMatchObject({status:409});
    expect(await owner.setGrant('synthetic-live-step-up',{...p,active:false},1)).toEqual({revision:2,active:false});
    const audits=(await pool.query('SELECT "revision","adminId","policySha256" FROM "B2bReceivedPolicyAudit" WHERE "grantKey"=$1 ORDER BY "revision"',[receptionGrantKey(scope,who,'READ')])).rows;
    expect(audits.map(a=>a.revision)).toEqual([1,2]);expect(audits[1].adminId).toBe(id(90));
    expect(audits[1].policySha256).toBe(hash({...p,active:false,revision:2}));
  });
  it('step-up revoked after policy/audit insert rolls both back',async()=>{
    const who={kind:'SERVICE' as const,clientId:id(23),subjectId:null},p=policy('READ',true,who);
    adminHook=async n=>{if(n===3)throw new B2bSecurityError(403,'STEP_UP_REVOKED');};
    await expect(owner.setGrant('synthetic-live-step-up',p,0)).rejects.toMatchObject({status:403});
    expect((await pool.query('SELECT count(*) AS n FROM "B2bReceivedReadGrant" WHERE "grantKey"=$1',[receptionGrantKey(scope,who,'READ')])).rows[0].n).toBe('0');
    expect((await pool.query('SELECT count(*) AS n FROM "B2bReceivedPolicyAudit" WHERE "grantKey"=$1',[receptionGrantKey(scope,who,'READ')])).rows[0].n).toBe('0');
  });
  it('concurrent stale CAS cannot commit twice or create an unaudited policy',async()=>{
    const who={kind:'SERVICE' as const,clientId:id(24),subjectId:null},p=policy('READ',true,who);await owner.setGrant('synthetic-live-step-up',p,0);
    const attempts=await Promise.allSettled([owner.setGrant('synthetic-live-step-up',{...p,active:false},1),owner.setGrant('synthetic-live-step-up',{...p,active:false},1)]);
    expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const failed=attempts.find(r=>r.status==='rejected') as PromiseRejectedResult;expect(failed.reason).toBeInstanceOf(B2bSecurityError);
    const key=receptionGrantKey(scope,who,'READ');expect((await pool.query('SELECT "revision" FROM "B2bReceivedReadGrant" WHERE "grantKey"=$1',[key])).rows[0].revision).toBe(2);
    expect((await pool.query('SELECT count(*) AS n FROM "B2bReceivedPolicyAudit" WHERE "grantKey"=$1',[key])).rows[0].n).toBe('2');
  });
  it('Identity revocation before transaction completion rolls back the read audit',async()=>{
    const before=await auditCount();identityHook=async n=>{if(n===2)revoked=true;};
    await expect(owner.execute(access,'DETAIL',{scope,id:docs.get('01')!.id})).rejects.toMatchObject({status:403});
    expect(await auditCount()).toBe(before);
  });
  it('Identity revocation after commit releases no response; committed audit remains a read-attempt record',async()=>{
    const before=await auditCount();identityHook=async n=>{if(n===3)revoked=true;};
    await expect(owner.execute(access,'DETAIL',{scope,id:docs.get('01')!.id})).rejects.toMatchObject({status:403});expect(await auditCount()).toBe(before+1);
  });
  it('local READ revocation denies subsequent uncached reads',async()=>{
    const previous=principal.clientId;principal.clientId=id(25);
    try{await grant('READ');await owner.execute(access,'LIST',query);await grant('READ',false,1);await expect(owner.execute(access,'LIST',query)).rejects.toMatchObject({status:403});}
    finally{principal.clientId=previous;}
  });
  it('audit SQL failure rolls back and is sanitized as a genuine B2bSecurityError',async()=>{
    const before=await auditCount();
    const failingDb:any={$transaction:(work:any,options:any)=>db.$transaction((sql:any)=>work({
      $queryRawUnsafe:sql.$queryRawUnsafe.bind(sql),$executeRawUnsafe:async(statement:string,...values:any[])=>{
        if(statement.includes('INSERT INTO "B2bReceivedReadAudit"'))throw new Error('SYNTHETIC_PRIVATE_AUDIT_SECRET');
        return sql.$executeRawUnsafe(statement,...values);
      },
    }),options)};
    const failing=new B2bReceptionReads(new PostgresReceivedReadStore(failingDb),identity,admin);
    const error=await failing.execute(access,'LIST',query).then(()=>null,e=>e);
    expect(error).toBeInstanceOf(B2bSecurityError);expect(error).toMatchObject({status:503,code:'RECEIVED_OWNER_UNAVAILABLE'});
    expect(String(error)).not.toContain('PRIVATE_AUDIT_SECRET');expect(await auditCount()).toBe(before);
  });
  it('caught SQL failure poisons the transaction and rolls back an earlier audit',async()=>{
    const before=await auditCount();await expect(store.transaction(async tx=>{
      await tx.audit(principal,scope,'LIST',null,null);
      await tx.audit(principal,scope,'INVALID',null,null).catch(()=>{});return 'must-not-commit';
    })).rejects.toBeInstanceOf(B2bSecurityError);expect(await auditCount()).toBe(before);
  });
  it('escaped transaction is closed after commit and rollback; unawaited started work is drained',async()=>{
    let escaped!:ReceivedReadTransaction;
    await store.transaction(async tx=>{escaped=tx;void tx.audit(principal,scope,'LIST',null,null);});
    const before=await auditCount();await expect(escaped.audit(principal,scope,'LIST',null,null)).rejects.toMatchObject({status:503});expect(await auditCount()).toBe(before);
    await expect(store.transaction(async tx=>{escaped=tx;throw new Error('rollback');})).rejects.toMatchObject({status:503});
    await expect(escaped.list(query)).rejects.toMatchObject({status:503});
  });
  it.each(['B2bReceivedReadAudit','B2bReceivedPolicyAudit'])('%s is append-only against UPDATE, DELETE and TRUNCATE',async table=>{
    const before=Number((await pool.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);
    for(const statement of [`UPDATE "${table}" SET "createdAt"="createdAt"`,`DELETE FROM "${table}"`,`TRUNCATE "${table}"`])await expect(pool.query(statement)).rejects.toMatchObject({code:'23514'});
    expect(Number((await pool.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n)).toBe(before);
  });
  it('policy identity/CAS and deferred audit guards prevent raw SQL bypass',async()=>{
    const key=receptionGrantKey(scope,receivedSubject(principal),'READ');
    await expect(pool.query('DELETE FROM "B2bReceivedReadGrant" WHERE "grantKey"=$1',[key])).rejects.toMatchObject({code:'23514'});
    // Include the referencing audit table so the candidate's own statement
    // guard, not PostgreSQL's earlier FK/TRUNCATE prohibition, is exercised.
    await expect(pool.query('TRUNCATE "B2bReceivedReadGrant", "B2bReceivedPolicyAudit"')).rejects.toMatchObject({code:'23514'});
    await expect(pool.query('UPDATE "B2bReceivedReadGrant" SET "revision"="revision" WHERE "grantKey"=$1',[key])).rejects.toMatchObject({code:'23514'});
    const forged={...policy('READ',true,{kind:'SERVICE',clientId:id(30),subjectId:null}),revision:1};
    await expect(pool.query('INSERT INTO "B2bReceivedReadGrant"("grantKey","policy","revision") VALUES($1,$2,1)',[hash('unaudited'),forged])).rejects.toMatchObject({code:'23514'});
  });
  it.each([
    (p:any)=>({...p,clientRevision:'1'}),
    (p:any)=>({...p,scope:{...p.scope,companyId:'1'}}),
    (p:any)=>({...p,scope:{...p.scope,branchId:'-'.repeat(36)}}),
    (p:any)=>({...p,subject:{...p.subject,subjectId:id(31)}}),
    (p:any)=>({...p,userAuthRevision:1}),
    (p:any)=>({...p,subject:{...p.subject,kind:'USER',subjectId:id(31)},userAuthRevision:null}),
  ])('SQL rejects ill-typed policy, fake SERVICE user and nullable USER revision %#',async mutate=>{
    const p=mutate({...policy('READ'),revision:1});
    await expect(pool.query('INSERT INTO "B2bReceivedReadGrant"("grantKey","policy","revision") VALUES($1,$2,1)',[hash(p),p])).rejects.toThrow();
  });
  it('audit schema rejects nullable USER auth revision, malformed scope and cross-document artifact membership',async()=>{
    const insert=(s:any,kind:string,subject:string|null,revision:number|null,doc:string|null,artifact:string|null,action:string)=>pool.query(`INSERT INTO "B2bReceivedReadAudit"
      ("clientId","subjectId","actorKind","scope","action","documentId","artifactId","clientRevision","userAuthRevision") VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)`,[principal.clientId,subject,kind,s,action,doc,artifact,revision]);
    await expect(insert(scope,'USER',id(31),null,null,null,'LIST')).rejects.toThrow();
    await expect(insert({environment:'BETA',recipientRuc:scope.recipientRuc},'SERVICE',null,null,null,null,'LIST')).rejects.toThrow();
    await expect(insert(scope,'SERVICE',null,null,docs.get('01')!.id,docs.get('03')!.artifacts[0].id,'CONTENT')).rejects.toMatchObject({code:'23514'});
    await expect(insert(scope,'SERVICE',null,null,docs.get('other-branch')!.id,null,'DETAIL')).rejects.toMatchObject({code:'23514'});
  });
  it('real artifact membership prevents reading a valid original belonging to another document',async()=>{
    const before=await auditCount();await expect(owner.execute(access,'CONTENT',{scope,id:docs.get('01')!.id,artifactId:docs.get('03')!.artifacts[0].id})).rejects.toMatchObject({status:404});expect(await auditCount()).toBe(before);
  });
  it.each(['CDR','PROVIDER_PDF'])('downloads the exact attached %s original without synthesizing evidence',async kind=>{
    const doc=docs.get('01')!,a=doc.artifacts.find(a=>a.kind===kind),file:any=await owner.execute(access,'CONTENT',{scope,id:doc.id,artifactId:a.id});
    expect(file.bytes).toEqual(Buffer.from(a.bytes));expect(file.sha256).toBe(a.sha256);
  });
  it('corrupted original bytes fail closed even when projection still matches',async()=>{
    const doc=docs.get('01')!,a=doc.artifacts.find(a=>a.kind==='XML');
    try{await db.receivedArtifact.update({where:{id:a.id},data:{bytes:Buffer.from('SYNTHETIC_CORRUPTION')}});
      await expect(owner.execute(access,'CONTENT',{scope,id:doc.id,artifactId:a.id})).rejects.toMatchObject({status:409});}
    finally{await db.receivedArtifact.update({where:{id:a.id},data:{bytes:a.bytes}});}
  });
  it('a substituted projection or summary column cannot leak through detail/list',async()=>{
    const doc=docs.get('01')!,record=await db.receivedDocument.findUniqueOrThrow({where:{id:doc.id}});
    try{const projection=structuredClone(record.projection);projection.items[0].quantity='999';
      await db.receivedDocument.update({where:{id:doc.id},data:{projection}});
      await expect(owner.execute(access,'DETAIL',{scope,id:doc.id})).rejects.toMatchObject({status:409});
      await db.receivedDocument.update({where:{id:doc.id},data:{projection:record.projection,payableAmount:'999'}});
      await expect(owner.execute(access,'LIST',query)).rejects.toMatchObject({status:409});
    }finally{await db.receivedDocument.update({where:{id:doc.id},data:{projection:record.projection,payableAmount:record.payableAmount}});}
  });
  it('a matching hash is insufficient for a CDR referencing a different original',async()=>{
    const doc=docs.get('01')!,a=doc.artifacts.find(a=>a.kind==='CDR'),bytes=Buffer.from(receivedCdr('FQA1-99999999'));
    const {createHash}=await import('node:crypto');
    try{await db.receivedArtifact.update({where:{id:a.id},data:{bytes,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length}});
      await expect(owner.execute(access,'CONTENT',{scope,id:doc.id,artifactId:a.id})).rejects.toThrow();
    }finally{await db.receivedArtifact.update({where:{id:a.id},data:{bytes:a.bytes,sha256:a.sha256,byteLength:a.byteLength}});}
  });
  it('does not create issuance, fiscal Outbox, series counter or owner membership writes',async()=>{
    for(const table of ['Document','OutboxEvent','SeriesCounter','CompanySettings','Branch','EmissionPoint']){
      expect((await pool.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n).toBe('0');
    }
    expect(await db.receivedDocument.count()).toBe(9);expect(await db.receivedItemRecord.count()).toBe(9);
  });
});
