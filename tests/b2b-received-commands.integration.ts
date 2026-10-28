import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {parseReceivedXml} from '../packages/received-core/src/index';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {PostgresReceptionWriteAuthority,receptionWriteGrantKey} from '../services/received-documents-service/src/b2b/write-authority';
import type {ReceptionWriteAction} from '../services/received-documents-service/src/b2b/commands';
import {fixture,scope,target,access,file,id} from './helpers/b2b-received-commands.fixture';
import {receivedXml,receivedCdr} from './received-fixture.mjs';
const require=createRequire(import.meta.url),{withReceivedCommandsDatabase}=require('./helpers/b2b-received-commands-db.cjs');
let db:any,pool:any,f:ReturnType<typeof fixture>,release:()=>void,completed:Promise<void>,seq=0;
const key=()=>`synthetic_command_${++seq}`;
const run=(action:ReceptionWriteAction,payload:unknown,s=scope,k=key())=>f.owner.execute(access,action,{scope:s,key:k,payload});
const count=async(table:string)=>Number((await pool.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);
const state=async()=>Promise.all(['ReceivedDocument','ReceivedItemRecord','ReceivedArtifact','B2bReceivedCommand'].map(count));
const imported=async(number=`FQA1-${String(++seq).padStart(8,'0')}`)=>{
 const xml=Buffer.from(receivedXml('01',number));const result=await run('IMPORT',file(xml));return {xml,result,id:result.documentId,number};
};
const wrap=(hook:(sql:string,values:any[])=>Promise<void>|void)=>({$transaction:(work:any,options:any)=>db.$transaction((tx:any)=>work({
 $queryRawUnsafe:tx.$queryRawUnsafe.bind(tx),$executeRawUnsafe:async(sql:string,...values:any[])=>{const n=await tx.$executeRawUnsafe(sql,...values);await hook(sql,values);return n;},
}),options)});
beforeAll(async()=>{
 let ready!:()=>void,failed!:(e:unknown)=>void;const initialized=new Promise<void>((a,b)=>{ready=a;failed=b;});const finished=new Promise<void>(r=>{release=r;});
 completed=withReceivedCommandsDatabase(async context=>{
  db=context.client;pool=context.pool;f=fixture(db);
  try{for(const action of ['IMPORT','ATTACH','ASSIGN','REGISTER'] as const)await f.grant(action);await f.grant('ASSIGN',target);ready();await finished;}catch(e){failed(e);throw e;}
 });void completed.catch(failed);await initialized;
},120000);
afterAll(async()=>{release?.();await completed;},120000);
beforeEach(()=>{f.control.identityCalls=0;f.control.adminCalls=0;f.control.identityHook=null;f.control.adminHook=null;f.control.revoked=false;f.control.adminRevision=1;f.control.badDigest=false;});
describe('B2B08 execute against NEW real network-none tmpfs PostgreSQL',()=>{
 it.each(['01','03','07','08','09','31'])('IMPORT %s saves exact original, every item decimal and one atomic audit',async type=>{
  const xml=Buffer.from(receivedXml(type,`FQA1-${String(++seq).padStart(8,'0')}`)),projection=parseReceivedXml(xml),before=await state();
  const r=await run('IMPORT',file(xml));expect(r).toMatchObject({outcome:'IMPORTED',fiscalAcceptance:'NOT_VERIFIED'});
  const doc=await db.receivedDocument.findUniqueOrThrow({where:{id:r.documentId}}),items=await db.receivedItemRecord.findMany({where:{documentId:r.documentId},orderBy:{ordinal:'asc'}}),artifacts=await db.receivedArtifact.findMany({where:{documentId:r.documentId}});
  expect(doc.projection).toEqual(projection);expect(items.map((i:any)=>i.detail)).toEqual(projection.items);expect(items[0]).toMatchObject({quantity:'5.000',unitValue:'20.000000',unitPrice:'23.60',amount:'100.00'});
  expect(Buffer.from(artifacts[0].bytes)).toEqual(xml);expect(artifacts[0].sha256).toBe(createHash('sha256').update(xml).digest('hex'));expect(artifacts).toHaveLength(1);
  expect(await state()).toEqual(before.map(n=>n+1));
 });
 it('accepts exactly 64 KiB and rejects the next byte without SQL writes',async()=>{
  const raw=receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`),xml=raw+' '.repeat(65536-Buffer.byteLength(raw));
  expect((await run('IMPORT',file(xml))).outcome).toBe('IMPORTED');const before=await state();
  await expect(run('IMPORT',file(xml+' '))).rejects.toMatchObject({status:413});expect(await state()).toEqual(before);
 });
 it('replays identical key exactly, rejects changed payload/action and preserves original on document duplicate',async()=>{
  const payload=file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`)),k=key(),r=await run('IMPORT',payload,scope,k),before=await state();
  expect(await run('IMPORT',payload,scope,k)).toEqual(r);expect(await state()).toEqual(before);
  await expect(run('IMPORT',{...payload,fileName:'renamed.xml'},scope,k)).rejects.toMatchObject({status:409,code:'IDEMPOTENCY_CONFLICT'});
  await expect(run('REGISTER',{documentId:r.documentId,registeredAt:null,erpReference:null,expectedErpReference:null},scope,k)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect(await run('IMPORT',payload)).toMatchObject({documentId:r.documentId,outcome:'DUPLICATE'});
  await expect(run('IMPORT',file(Buffer.from(payload.contentBase64,'base64').toString().replace('Combustible','Otro')))).rejects.toMatchObject({code:'RECEIVED_ORIGINAL_CONFLICT'});
 });
 it('simultaneous identical commands converge to a single atomic result',async()=>{
  const payload=file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`)),k=key(),before=await state();
  const results=await Promise.all([run('IMPORT',payload,scope,k),run('IMPORT',payload,scope,k)]);expect(results[0]).toEqual(results[1]);expect(await state()).toEqual(before.map(n=>n+1));
 });
 it('simultaneous original import with different keys cannot duplicate items or original',async()=>{
  const payload=file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`)),before=await state();
  const results=await Promise.all([run('IMPORT',payload),run('IMPORT',payload)]);expect(results.map(r=>r.outcome).sort()).toEqual(['DUPLICATE','IMPORTED']);expect(results[0].documentId).toBe(results[1].documentId);
  expect(await state()).toEqual(before.map((n,i)=>n+(i===3?2:1)));
 });
 it('missing local WRITE policy denies despite Identity write scope; READ is never created or inherited',async()=>{
  const previous=f.principal.clientId;f.principal.clientId=id(20);const before=await state();
  try{await expect(run('IMPORT',file(receivedXml()))).rejects.toMatchObject({status:403,code:'RECEIVED_WRITE_GRANT_REQUIRED'});}finally{f.principal.clientId=previous;}
  expect(await state()).toEqual(before);expect(await count('B2bReceivedReadGrant')).toBe(0);
 });
 it('mid-transaction policy revocation rolls back document/items/original/command; revocation persists',async()=>{
  const previous=f.principal.clientId;f.principal.clientId=id(21);
  try{await f.grant('IMPORT');const before=await state();let revoked=false;
   const owner=f.alternate(wrap(async sql=>{if(!revoked&&sql.includes('INSERT INTO "ReceivedItemRecord"')){revoked=true;await f.grant('IMPORT',scope,1,false);}}));
   await expect(owner.execute(access,'IMPORT',{scope,key:key(),payload:file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`))})).rejects.toMatchObject({status:403});expect(await state()).toEqual(before);
   await expect(f.authority.authorize(f.principal,scope,'IMPORT')).rejects.toMatchObject({status:403});
  }finally{f.principal.clientId=previous;}
 });
 it('Identity revocation after command audit INSERT rolls every mutation back',async()=>{
  const before=await state(),owner=f.alternate(wrap(sql=>{if(sql.includes('INSERT INTO "B2bReceivedCommand"'))f.control.revoked=true;}));
  await expect(owner.execute(access,'IMPORT',{scope,key:key(),payload:file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`))})).rejects.toMatchObject({status:403});expect(await state()).toEqual(before);
 });
 it('SQL audit failure and item failure return finite errors and roll back',async()=>{
  for(const marker of ['INSERT INTO "B2bReceivedCommand"','INSERT INTO "ReceivedItemRecord"']){
   const before=await state(),owner=f.alternate(wrap(sql=>{if(sql.includes(marker))throw new Error('SYNTHETIC_PRIVATE_SQL');}));
   const error=await owner.execute(access,'IMPORT',{scope,key:key(),payload:file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`))}).catch(e=>e);
   expect(error).toBeInstanceOf(B2bSecurityError);expect(error).toMatchObject({status:503,code:'RECEIVED_OWNER_UNAVAILABLE'});expect(await state()).toEqual(before);
  }
 });
 it('cross-RUC/company/branch tuples fail closed and imported recipient must match',async()=>{
  const before=await state();for(const foreign of [{...scope,recipientRuc:'00000000202'},{...scope,companyId:2},{...scope,branchId:id(99)}])await expect(run('IMPORT',file(receivedXml()),foreign)).rejects.toMatchObject({status:404});
  await expect(run('IMPORT',file(receivedXml('01','FQA1-99999999','00000000202')))).rejects.toMatchObject({code:'RECEIVED_XML_CONTEXT_MISMATCH'});expect(await state()).toEqual(before);
 });
 it('ATTACH CDR rejects wrong number/type/recipient; preserves exact valid CDR and PDF without fiscal acceptance',async()=>{
  const doc=await imported(),before=await state();
  for(const cdr of [receivedCdr('FQA1-99999999'),receivedCdr(doc.number,'03'),receivedCdr(doc.number).replace('</cac:DocumentResponse>','<cac:RecipientParty><cac:PartyIdentification><cbc:ID schemeID="6">00000000999</cbc:ID></cac:PartyIdentification></cac:RecipientParty></cac:DocumentResponse>')])
   await expect(run('ATTACH',{documentId:doc.id,kind:'CDR',file:file(cdr,'R-original.xml')})).rejects.toMatchObject({status:409,code:'RECEIVED_CDR_MISMATCH'});
  expect(await state()).toEqual(before);
  for(const [kind,bytes,name] of [['CDR',receivedCdr(doc.number),'R-original.xml'],['PROVIDER_PDF','%PDF-1.4 SYNTHETIC ONLY','provider.pdf']]){
   expect(await run('ATTACH',{documentId:doc.id,kind,file:file(bytes,name)})).toMatchObject({outcome:'ATTACHED',fiscalAcceptance:'NOT_VERIFIED'});
   const artifact=await db.receivedArtifact.findFirstOrThrow({where:{documentId:doc.id,kind}});expect(Buffer.from(artifact.bytes)).toEqual(Buffer.from(bytes));
  }
  await expect(run('ATTACH',{documentId:doc.id,kind:'PROVIDER_PDF',file:file('invalid','bad.pdf')})).rejects.toMatchObject({status:400});
  await expect(run('ATTACH',{documentId:doc.id,kind:'XML',file:file(doc.xml)})).rejects.toMatchObject({status:400});
 });
 it('ASSIGN requires both anchors and grants; preserves every fiscal fact and registration',async()=>{
  const doc=await imported();await run('REGISTER',{documentId:doc.id,registeredAt:'2026-10-24T12:34:56.000Z',erpReference:'ERP-0001',expectedErpReference:null});
  const before=await db.receivedDocument.findUniqueOrThrow({where:{id:doc.id}}),payload={documentId:doc.id,targetBranchId:target.branchId,expectedXmlSha256:before.xmlSha256},k=key();
  const bindings=f.principal.bindings;f.principal.bindings=bindings.slice(0,1);
  try{await expect(run('ASSIGN',payload)).rejects.toMatchObject({status:404});}finally{f.principal.bindings=bindings;}
  await expect(run('ASSIGN',{...payload,registeredAt:null})).rejects.toMatchObject({status:400});
  await expect(run('ASSIGN',{...payload,expectedXmlSha256:'0'.repeat(64)})).rejects.toMatchObject({status:409});
  const result=await run('ASSIGN',payload,scope,k);expect(result).toMatchObject({outcome:'ASSIGNED',branchId:target.branchId});expect(await run('ASSIGN',payload,scope,k)).toEqual(result);
  const after=await db.receivedDocument.findUniqueOrThrow({where:{id:doc.id}});expect(after).toEqual({...before,branchId:target.branchId});
  await expect(run('REGISTER',{documentId:doc.id,registeredAt:null,erpReference:null,expectedErpReference:'ERP-0001'})).rejects.toMatchObject({status:404});
 });
 it('ASSIGN target grant is independent and revocation after command audit INSERT rolls branch back',async()=>{
  const doc=await imported(),record=await db.receivedDocument.findUniqueOrThrow({where:{id:doc.id}}),previous=f.principal.clientId;f.principal.clientId=id(22);
  try{await f.grant('ASSIGN');const payload={documentId:doc.id,targetBranchId:target.branchId,expectedXmlSha256:record.xmlSha256};
   await expect(run('ASSIGN',payload)).rejects.toMatchObject({status:403});await f.grant('ASSIGN',target);
   let revoked=false;const owner=f.alternate(wrap(async sql=>{if(!revoked&&sql.includes('INSERT INTO "B2bReceivedCommand"')){revoked=true;await f.grant('ASSIGN',target,1,false);}}));
   const before=await state();await expect(owner.execute(access,'ASSIGN',{scope,key:key(),payload})).rejects.toMatchObject({status:403});expect(await state()).toEqual(before);
   expect((await db.receivedDocument.findUniqueOrThrow({where:{id:doc.id}})).branchId).toBe(scope.branchId);
  }finally{f.principal.clientId=previous;}
 });
 it('REGISTER requires round-trip strict UTC date and ERP CAS; concurrent stale CAS has one winner',async()=>{
  const doc=await imported(),payload={documentId:doc.id,registeredAt:'2026-10-24T00:00:00.000Z',erpReference:'ERP-STRICT',expectedErpReference:null};
  for(const registeredAt of ['2026-02-30T00:00:00.000Z','2026-10-24T24:00:00.000Z','2026-10-24','2026-10-24T00:00:00Z'])await expect(run('REGISTER',{...payload,registeredAt})).rejects.toMatchObject({code:'RECEIVED_REGISTRATION_CONFLICT'});
  for(const erpReference of ['', ' ','a\n','a'.repeat(121)])await expect(run('REGISTER',{...payload,erpReference})).rejects.toMatchObject({status:409});
  const results=await Promise.allSettled([run('REGISTER',payload),run('REGISTER',{...payload,erpReference:'ERP-OTHER'})]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;expect(rejected.reason).toMatchObject({status:409});
  await expect(run('REGISTER',payload)).rejects.toMatchObject({code:'RECEIVED_REGISTRATION_CONFLICT'});
 });
 it('persistent policy binds exact subject, client revision, USER auth revision and action',async()=>{
  const previous={...f.principal};f.principal.clientId=id(23);
  try{
   await f.grant('IMPORT');await expect(f.authority.authorize(f.principal,scope,'ATTACH')).rejects.toMatchObject({status:403});
   f.principal.revision=2;await expect(f.authority.authorize(f.principal,scope,'IMPORT')).rejects.toMatchObject({status:403});f.principal.revision=1;
   f.principal.kind='USER';f.principal.subjectId=id(24);f.principal.userAuthRevision=1;
   await expect(f.authority.authorize(f.principal,scope,'IMPORT')).rejects.toMatchObject({status:403});await f.grant('IMPORT');
   await f.owner.execute({token:access.token,kind:'USER'},'IMPORT',{scope,key:key(),payload:file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`))});
   const audit=(await pool.query('SELECT "actorKind","subjectId","userAuthRevision" FROM "B2bReceivedCommand" WHERE "subjectId"=$1',[id(24)])).rows[0];expect(audit).toEqual({actorKind:'USER',subjectId:id(24),userAuthRevision:1});
   f.principal.userAuthRevision=2;await expect(f.authority.authorize(f.principal,scope,'IMPORT')).rejects.toMatchObject({status:403});
  }finally{Object.assign(f.principal,previous);}
 });
 it('setGrant uses exact digest/opaque step-up, persistent CAS and append-only audit',async()=>{
  const requested={...f.policy('IMPORT'),subject:{kind:'SERVICE',clientId:id(25),subjectId:null}},expectedDigest=hash({policy:requested,expectedRevision:0});
  await expect(f.authority.setGrant('wrong',requested,0)).rejects.toMatchObject({status:403});
  f.control.badDigest=true;await expect(f.authority.setGrant('synthetic-live-step-up',requested,0)).rejects.toMatchObject({status:403});f.control.badDigest=false;
  f.control.adminHook=(_n,digest)=>{expect(digest).toBe(expectedDigest);};expect(await f.authority.setGrant('synthetic-live-step-up',requested,0)).toEqual({revision:1,active:true});f.control.adminHook=null;
  await expect(f.authority.setGrant('synthetic-live-step-up',requested,0)).rejects.toMatchObject({status:409});
  const result=await Promise.allSettled([f.authority.setGrant('synthetic-live-step-up',{...requested,active:false},1),f.authority.setGrant('synthetic-live-step-up',{...requested,active:false},1)]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const row=(await pool.query('SELECT * FROM "B2bReceivedWriteGrant" WHERE "grantKey"=$1',[receptionWriteGrantKey(scope,requested.subject,'IMPORT')])).rows[0];expect(row.revision).toBe(2);
  const audits=(await pool.query('SELECT * FROM "B2bReceivedWritePolicyAudit" WHERE "policyId"=$1 ORDER BY "revision"',[row.policyId])).rows;expect(audits.map((a:any)=>a.revision)).toEqual([1,2]);expect(audits[1]).toMatchObject({adminId:id(90),authRevision:1,policySha256:hash({...requested,active:false,revision:2})});
 });
 it('step-up changes inside transaction roll policy and audit back',async()=>{
  const requested={...f.policy('IMPORT'),subject:{kind:'SERVICE',clientId:id(26),subjectId:null}},before=await count('B2bReceivedWritePolicyAudit');
  f.control.adminHook=n=>{if(n===4)f.control.adminRevision=2;};
  await expect(f.authority.setGrant('synthetic-live-step-up',requested,0)).rejects.toMatchObject({status:403});expect(await count('B2bReceivedWritePolicyAudit')).toBe(before);
  expect((await pool.query('SELECT count(*) AS n FROM "B2bReceivedWriteGrant" WHERE "grantKey"=$1',[receptionWriteGrantKey(scope,requested.subject,'IMPORT')])).rows[0].n).toBe('0');
 });
 it.each(['B2bReceivedCommand','B2bReceivedWritePolicyAudit'])('%s is append-only against UPDATE, DELETE and TRUNCATE',async table=>{
  for(const sql of [`UPDATE "${table}" SET "createdAt"="createdAt"`,`DELETE FROM "${table}"`,`TRUNCATE "${table}"`])await expect(pool.query(sql)).rejects.toMatchObject({code:'23514'});
 });
 it('SQL enforces write-policy identity/CAS/deferred audit and denies mutation of provider facts',async()=>{
  const grant=(await pool.query('SELECT * FROM "B2bReceivedWriteGrant" LIMIT 1')).rows[0];
  await expect(pool.query('UPDATE "B2bReceivedWriteGrant" SET "revision"="revision" WHERE "grantKey"=$1',[grant.grantKey])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('DELETE FROM "B2bReceivedWriteGrant" WHERE "grantKey"=$1',[grant.grantKey])).rejects.toMatchObject({code:'23514'});
  const p={...f.policy('IMPORT'),subject:{kind:'SERVICE',clientId:id(27),subjectId:null},revision:1};
  await expect(pool.query('INSERT INTO "B2bReceivedWriteGrant"("grantKey","policyId","policy","revision") VALUES($1,$2,$3,1)',[receptionWriteGrantKey(scope,p.subject,'IMPORT'),id(28),p])).rejects.toMatchObject({code:'23514'});
  const doc=await imported();await expect(pool.query('UPDATE "ReceivedDocument" SET "projection"=\'{}\' WHERE "id"=$1',[doc.id])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('UPDATE "ReceivedArtifact" SET "bytes"=\'bad\' WHERE "documentId"=$1',[doc.id])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('UPDATE "ReceivedItemRecord" SET "quantity"=\'999\' WHERE "documentId"=$1',[doc.id])).rejects.toMatchObject({code:'23514'});
 });
 it('revoked IMPORT policy denies an idempotent replay without duplicating prior work',async()=>{
  const previous=f.principal.clientId;f.principal.clientId=id(31);
  try{
   await f.grant('IMPORT');const payload=file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`)),k=key();await run('IMPORT',payload,scope,k);
   await f.grant('IMPORT',scope,1,false);const before=await state();
   await expect(run('IMPORT',payload,scope,k)).rejects.toMatchObject({status:403});expect(await state()).toEqual(before);
  }finally{f.principal.clientId=previous;}
 });
 it('ASSIGN replay rechecks destination WRITE after the original has moved',async()=>{
  const previous=f.principal.clientId;f.principal.clientId=id(32);
  try{
   await f.grant('IMPORT');await f.grant('ASSIGN');await f.grant('ASSIGN',target);const doc=await imported(),record=await db.receivedDocument.findUniqueOrThrow({where:{id:doc.id}});
   const payload={documentId:doc.id,targetBranchId:target.branchId,expectedXmlSha256:record.xmlSha256},k=key();await run('ASSIGN',payload,scope,k);
   await f.grant('ASSIGN',target,1,false);const before=await state();
   await expect(run('ASSIGN',payload,scope,k)).rejects.toMatchObject({status:403});expect(await state()).toEqual(before);
  }finally{f.principal.clientId=previous;}
 });
 it('post-commit Identity revocation releases no result; retry with live access returns the committed result',async()=>{
  const before=await state(),k=key(),payload=file(receivedXml('01',`FQA1-${String(++seq).padStart(8,'0')}`));
  const database={$transaction:async(work:any,options:any)=>{const r=await db.$transaction(work,options);f.control.revoked=true;return r;}};
  await expect(f.alternate(database).execute(access,'IMPORT',{scope,key:k,payload})).rejects.toMatchObject({status:403});expect(await state()).toEqual(before.map(n=>n+1));
  f.control.revoked=false;const r=await run('IMPORT',payload,scope,k);expect(r.outcome).toBe('IMPORTED');expect(await state()).toEqual(before.map(n=>n+1));
 });
 it('post-commit step-up change denies acknowledgement and retains the committed audit',async()=>{
  const requested={...f.policy('IMPORT'),subject:{kind:'SERVICE',clientId:id(33),subjectId:null}},before=await count('B2bReceivedWritePolicyAudit');
  f.control.adminHook=n=>{if(n===5)f.control.adminRevision=2;};
  await expect(f.authority.setGrant('synthetic-live-step-up',requested,0)).rejects.toMatchObject({status:403});
  expect(await count('B2bReceivedWritePolicyAudit')).toBe(before+1);
  expect((await pool.query('SELECT "revision" FROM "B2bReceivedWriteGrant" WHERE "grantKey"=$1',[receptionWriteGrantKey(scope,requested.subject,'IMPORT')])).rows[0].revision).toBe(1);
 });
 it.each([
  (p:any)=>({...p,permission:'READ'}),
  (p:any)=>({...p,subject:{...p.subject,subjectId:id(34)}}),
  (p:any)=>({...p,userAuthRevision:1}),
  (p:any)=>({...p,subject:{...p.subject,kind:'USER',subjectId:id(34)},userAuthRevision:null}),
  (p:any)=>({...p,clientRevision:'1'}),
 ])('SQL rejects extra READ field and malformed SERVICE/USER policy %#',async mutate=>{
  const p=mutate({...f.policy('IMPORT'),subject:{kind:'SERVICE',clientId:id(35),subjectId:null},revision:1});
  await expect(pool.query('INSERT INTO "B2bReceivedWriteGrant"("grantKey","policyId","policy","revision") VALUES($1,$2,$3,1)',[receptionWriteGrantKey(scope,p.subject,'IMPORT'),id(36),p])).rejects.toMatchObject({code:'23514'});
 });
 it('SQL rejects JSON null/extra result facts and a fabricated SERVICE human',async()=>{
  const audit=(await pool.query('SELECT * FROM "B2bReceivedCommand" WHERE "actorKind"=\'SERVICE\' AND "action"=\'IMPORT\' LIMIT 1')).rows[0];
  const insert=(result:any,subject:string|null=null,userRevision:number|null=null)=>pool.query(`INSERT INTO "B2bReceivedCommand"
   ("key","requestHash","clientId","subjectId","actorKind","scope","action","result","clientRevision","userAuthRevision","authority")
   VALUES($1,$2,$3,$4,'SERVICE',$5,'IMPORT',$6,$7,$8,$9)`,[hash(key()),audit.requestHash,audit.clientId,subject,audit.scope,result,audit.clientRevision,userRevision,JSON.stringify(audit.authority)]);
  await expect(insert({...audit.result,fiscalAcceptance:null})).rejects.toMatchObject({code:'23514'});
  await expect(insert({...audit.result,officialAcceptance:true})).rejects.toMatchObject({code:'23514'});
  await expect(insert(audit.result,id(37),1)).rejects.toMatchObject({code:'23514'});
 });
 it('malformed import XML returns a finite parser error with zero mutations',async()=>{
  const before=await state();await expect(run('IMPORT',file('<invalid/>'))).rejects.toMatchObject({status:400,code:'INVALID_RECEIVED_XML'});expect(await state()).toEqual(before);
 });
 it('never invents a SERVICE human, grants READ automatically or writes emission/Outbox/counters/memberships',async()=>{
  const services=(await pool.query('SELECT "subjectId","userAuthRevision" FROM "B2bReceivedCommand" WHERE "actorKind"=\'SERVICE\'')).rows;expect(services.length).toBeGreaterThan(0);expect(services.every((a:any)=>a.subjectId===null&&a.userAuthRevision===null)).toBe(true);
  for(const table of ['B2bReceivedReadGrant','ReceivedAudit','Document','OutboxEvent','SeriesCounter','CompanySettings','Branch','EmissionPoint'])expect(await count(table)).toBe(0);
 });
});



