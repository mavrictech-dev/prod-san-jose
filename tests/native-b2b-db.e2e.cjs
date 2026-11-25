'use strict';
// Explicit isolated native PostgreSQL only. No installed database, customer credential
// or official SUNAT endpoint is accepted. Fiscal admission here is synthetic evidence.
const assert=require('node:assert/strict'),{createRequire}=require('node:module'),{readFileSync}=require('node:fs'),{join,resolve}=require('node:path'),{randomUUID}=require('node:crypto');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only']);
const root=resolve(__dirname,'..'),local=createRequire(join(root,'services/billing-service/package.json')),identityRequire=createRequire(join(root,'services/identity-service/package.json'));
local('reflect-metadata');
process.env.NODE_PATH=join(root,'services/billing-service/node_modules');
const {withNativeCorrection}=require('./helpers/native-postgres.cjs'),{update}=require('../scripts/update-igv-catalogs-gre.cjs');
const {NativeB2bPrismaStore}=local('@factuez/service-access/dist/native-b2b-store'),{nativeServicePrincipalId}=local('@factuez/service-access/dist/native-b2b-rpc');
const {ProductionIdentity}=identityRequire('./dist/b2b/production-identity'),{NativeB2bBillingAuthority}=local('./dist/native-b2b-authority'),{NativeB2bCommands}=local('./dist/native-b2b-commands');
const {IssueDocumentService}=local('./dist/application/issue-document.service'),{CatalogTaxService}=local('./dist/application/catalog-tax.service');
const {ProductionNotesOwnerService}=local('./dist/application/production-notes-owner.service'),{ProductionGuidesOwner}=local('./dist/production-guides-owner');
const {NativeB2bReads}=local('./dist/native-b2b-read'),{IssuanceQueryService}=local('./dist/application/issuance-query.service'),{PrintBrandingService}=local('./dist/application/print-branding.service');
const core=local('@factuez/sunat-core'),{generateKeyPairSync}=require('node:crypto');
const groups=[];async function check(name,work){await work();groups.push(name);console.log('PASS '+name);}
async function main(){await withNativeCorrection(async({pool,client:db})=>{
 await update(pool,{root,service:'billing-service',apply:true});
 await pool.query(readFileSync(join(root,'services/billing-service/prisma/production-notes-schema.sql'),'utf8'));
 const m=await update(pool,{root,service:'billing-service'});assert.deepEqual(m.pending,[]);
 const {Pool}=local('pg');await pool.query('CREATE DATABASE isolated_identity');const idPool=new Pool({...pool.options,database:'isolated_identity'});
 const {PrismaPg}=local('@prisma/adapter-pg'),IdentityClient=identityRequire('./dist/generated/prisma/client').PrismaClient;
 const idDb=new IdentityClient({adapter:new PrismaPg(idPool)});
 try{
  await update(idPool,{root,service:'identity-service',apply:true});
  const ruc='20100070970',branch=randomUUID(),point=randomUUID(),seriesIds={};
  const company=await db.companySettings.create({data:{ruc,legalName:'ISOLATED SYNTHETIC ISSUER',companyType:'SYNTHETIC',economicActivities:[],taxAddress:'FICTITIOUS ADDRESS',ubigeo:'150101',contactEmails:[],environment:'PRODUCTION'}});
  await db.branch.create({data:{id:branch,companyId:company.id,code:'SYNTHETIC',name:'SYNTHETIC BRANCH',establishmentCode:'0001'}});
  await db.emissionPoint.create({data:{id:point,companyId:company.id,branchId:branch,code:'SYNTHETIC',name:'SYNTHETIC POINT'}});
  for(const [code,type,series] of [['01','INVOICE','F991'],['03','SALES_RECEIPT','B991'],['07','CREDIT_NOTE','FC91'],['08','DEBIT_NOTE','FD91'],['09','DESPATCH_ADVICE','T991']]){const row=await db.seriesCounter.create({data:{companyId:company.id,emissionPointId:point,documentType:type,series,environment:'PRODUCTION'}});seriesIds[code]=row;}
  const bind=code=>({ruc,branchId:branch,pointId:point,series:seriesIds[code].series});
  const scope=code=>(code==='01'||code==='03'?'production:documents:issue:':code==='07'||code==='08'?'production:notes:issue:':'production:guides:issue:')+code;
  const grants=Object.keys(seriesIds).flatMap(code=>['production:documents:read','production:masters:read',scope(code)].map(scope=>({scope,binding:bind(code)})));
  const authority=new NativeB2bBillingAuthority(db);
  const identity=new ProductionIdentity(new NativeB2bPrismaStore(idDb),{verify:async credential=>{assert.equal(credential,'synthetic-admin');return {id:randomUUID()};}},{validate:g=>authority.validateGrants(g).then(()=>{})});
  authority.rpc=()=>({introspect:token=>identity.introspect(token),post:async(role,path,body)=>{assert.equal(role,'identity');assert.equal(path,'/internal/native-b2b/identity/current');return identity.currentClient(body.clientId);}});
  let credentials=await identity.register('synthetic-admin',{label:'ISOLATED SYNTHETIC APPLICATION',grants});
  const scopes=[...new Set(grants.map(g=>g.scope))].join(' '),basic=()=> 'Basic '+Buffer.from(credentials.clientId+':'+credentials.clientSecret).toString('base64');
  const token=await identity.token(basic(),{grant_type:'client_credentials',scope:scopes},'synthetic-peer'),authorization='Bearer '+token.access_token;
  const actor=await authority.actor(authorization);
  let fiscalCalls=0,denyAdmission=false;
  authority.fiscal=async(path,payload,ctx)=>{await authority.verifyContext(ctx,ctx.productionBinding.documentType);fiscalCalls++;if(denyAdmission)throw Error('SYNTHETIC_ADMISSION_DENIED');assert.equal(path,'admission');const s=payload.snapshot;return {authorized:true,environment:'PRODUCTION',issuerRuc:ruc,profile:'01-03-PEN-0101-TAX10-20-30-v3',documentId:s.documentId,snapshotSha256:core.fiscalSnapshotSha256(s)};};
  process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED='true';process.env.BILLING_PRODUCTION_NOTES_ENABLED='true';
  const tax=new CatalogTaxService(db),issue=new IssueDocumentService(db,undefined,tax,authority),notes=new ProductionNotesOwnerService(db,authority);
  const keys=generateKeyPairSync('ed25519'),signer=core.createProductionGuidesSigner('synthetic',keys.privateKey),verifier=core.createProductionGuidesVerifier(new Map([['synthetic',keys.publicKey]]));
  let serviceEnabled=true;
  const guides=new ProductionGuidesOwner(db,{enabled:()=>true,authority,signer,ownerVerifier:verifier,statusVerifier:verifier,actorCurrent:async()=>({active:true,canIssue:true,scope:{kind:'GLOBAL'}}),serviceCurrent:async(s,sc)=>{const current=await identity.currentClient(s.clientId);return {active:current.enabled&&serviceEnabled&&current.revision===s.revision,canIssue:current.enabled&&current.revision===s.revision,scope:{kind:'ASSIGNED',branchIds:[sc.branchId],emissionPointIds:[sc.pointId],series:[sc.seriesCounterId]}};},sunat:{admit:async()=>{},grantEvidence:async()=>({credentialRevision:1,certificateFingerprint:'a'.repeat(64),rulesSha256:'b'.repeat(64),xsdSha256:core.PRODUCTION_GUIDES_XSD_SHA256}),status:async()=>{throw Error('NO_OFFICIAL_EVIDENCE');},artifact:async()=>{throw Error('NO_OFFICIAL_EVIDENCE');},pdf:async()=>{throw Error('NO_OFFICIAL_EVIDENCE');}}});
  const commands=new NativeB2bCommands(db,authority,issue,notes,guides),printing=new PrintBrandingService(db),reads=new NativeB2bReads(db,authority,new IssuanceQueryService(db),tax,printing);
  const invoice={paymentTerms:{type:'CONTADO'},documentType:'INVOICE',emissionPointId:point,series:'F991',customer:{identityType:'6',identityNumber:'20131312955',legalName:'FICTITIOUS CUSTOMER'},lines:[{description:'FICTITIOUS ITEM',quantity:'2',unitCode:'NIU',unitPriceWithTax:'11.80',igvRate:'18',taxAffectationCode:'10'}]};
  let issued;
  await check('GET_NATIVE_MASTER_SCOPE_AND_NO_COUNTER_OR_OUTBOX_EFFECTS',async()=>{
   const before=await db.seriesCounter.findUnique({where:{id:seriesIds['01'].id}}),events=await db.outboxEvent.count();
   assert.equal((await reads.masters('issuers',actor,{})).items[0].ruc,ruc);
   assert.equal((await reads.masters('series',actor,{documentType:'01'})).items[0].numberReserved,false);
   await assert.rejects(()=>reads.masters('points',actor,{pointId:randomUUID()}));
   assert.equal((await db.seriesCounter.findUnique({where:{id:before.id}})).nextNumber,before.nextNumber);assert.equal(await db.outboxEvent.count(),events);
  });
  await check('REAL_NATIVE_PRODUCER_CONCURRENT_IDEMPOTENCY_AND_NULL_HUMAN_FK',async()=>{
   const request={binding:bind('01'),payload:invoice},results=await Promise.allSettled(Array.from({length:8},()=>commands.execute(authorization,request,'same_native_key','documents')));
   const ok=results.filter(r=>r.status==='fulfilled');if(!ok.length)throw results[0].reason;issued=ok[0].value;assert.equal(new Set(ok.map(r=>r.value.documentId)).size,1);
   const row=await db.document.findUnique({where:{id:issued.documentId}});assert.equal(row.createdByUserId,null);assert.equal(row.createdByActor.kind,'SERVICE');assert.equal(row.createdByActor.clientId,actor.clientId);assert.equal(row.payableAmount.toString(),'23.6');
   assert.equal((await db.seriesCounter.findUnique({where:{id:seriesIds['01'].id}})).nextNumber,2n);assert.equal(await db.outboxEvent.count(),1);
   assert.equal((await commands.execute(authorization,request,'same_native_key','documents')).documentId,row.id);
   await assert.rejects(()=>commands.execute(authorization,{...request,payload:{...invoice,customer:{...invoice.customer,legalName:'CHANGED'}}},'same_native_key','documents'),e=>e.code==='IDEMPOTENCY_CONFLICT');
   assert.equal((await commands.operation(actor,issued.operationId)).nativeDocument.id,row.id);
   const detail=await reads.document(actor,row.id);assert.equal(detail.document.emissionPointId,point);
  });
  await check('INVALID_AFFECTATION_FIELD_AND_FISCAL_DENIAL_ALLOCATE_NOTHING',async()=>{
   const before=(await db.seriesCounter.findUnique({where:{id:seriesIds['01'].id}})).nextNumber;
   await assert.rejects(()=>commands.execute(authorization,{binding:bind('01'),payload:{...invoice,lines:[{...invoice.lines[0],taxAffectationCode:'18'}]}},'invalid_field','documents'),e=>!!e.getResponse().fieldErrors['lines[0].taxAffectationCode']);
   denyAdmission=true;await assert.rejects(()=>commands.execute(authorization,{binding:bind('01'),payload:invoice},'denied_admission','documents'));denyAdmission=false;
   assert.equal((await db.seriesCounter.findUnique({where:{id:seriesIds['01'].id}})).nextNumber,before);assert.equal(await db.outboxEvent.count(),1);
  });
  await check('NATIVE_CREDIT_NOTE_SAME_OWNER_AND_ORIGINAL_SERIES_AUTHORITY',async()=>{
   const {mkdtempSync,writeFileSync,unlinkSync,rmdirSync}=require('node:fs'),{tmpdir}=require('node:os'),{randomBytes}=require('node:crypto');
   const temporary=mkdtempSync(join(tmpdir(),'factuez-b2b-notes-synthetic-')),keyFile=join(temporary,'owner.key'),prior=process.env.PRODUCTION_NOTES_OWNER_KEY_FILE;
   writeFileSync(keyFile,randomBytes(32).toString('hex'),{flag:'wx'});process.env.PRODUCTION_NOTES_OWNER_KEY_FILE=keyFile;
   try{
    await db.document.update({where:{id:issued.documentId},data:{sunatStatus:'ACCEPTED'}});
    notes.remote=async(_company,kind,body)=>kind==='original-evidence'?{profile:'PRODUCTION-01-ARCHIVE-v1',documentId:body.original.documentId,snapshotSha256:core.fiscalSnapshotSha256(body.original),signedXmlSha256:'a'.repeat(64),cdrXmlSha256:'b'.repeat(64),cdrZipSha256:'c'.repeat(64),acceptedAt:new Date().toISOString(),checkedAt:new Date().toISOString()}:{authorized:true,profile:body.snapshot.profile,snapshotSha256:core.fiscalSnapshotSha256(body.snapshot),grantVersion:1,credentialRevision:1,certificateFingerprint:'d'.repeat(64)};
    const payload={seriesCounterId:seriesIds['07'].id,adjustment:{documentTypeCode:'07',reasonCode:'01',reasonDescription:'FICTITIOUS ANNULMENT'}};
    const ctx=commands.context(actor,await authority.resolve(actor,scope('07'),bind('07')),authorization,randomUUID());
    assert.equal((await notes.readyB2B(issued.documentId,ctx)).series[0].id,seriesIds['07'].id);
    const result=await commands.execute(authorization,{binding:bind('07'),payload},'synthetic_note','notes',issued.documentId),row=await db.document.findUnique({where:{id:result.documentId}});
    assert.equal(row.createdByUserId,null);assert.equal(row.createdByActor.clientId,actor.clientId);assert.equal(row.type,'CREDIT_NOTE');
    const reservation=(await db.$queryRawUnsafe('SELECT * FROM "ProductionNotesReservation" WHERE "documentId"=$1::uuid',row.id))[0];assert.equal(reservation.actorId,nativeServicePrincipalId(actor.clientId));
    assert.equal((await db.seriesCounter.findUnique({where:{id:seriesIds['07'].id}})).nextNumber,2n);
    assert.equal((await commands.execute(authorization,{binding:bind('07'),payload},'synthetic_note','notes',issued.documentId)).documentId,row.id);
   }finally{if(prior===undefined)delete process.env.PRODUCTION_NOTES_OWNER_KEY_FILE;else process.env.PRODUCTION_NOTES_OWNER_KEY_FILE=prior;unlinkSync(keyFile);rmdirSync(temporary);}
  });
  await check('READ_BOUNDARIES_AND_CREDENTIAL_REVOCATION_ON_CURRENT_OWNER',async()=>{
   const narrow=await identity.register('synthetic-admin',{label:'ISOLATED DIFFERENT SERIES',grants:grants.filter(g=>g.binding.series==='B991')}),t=await identity.token('Basic '+Buffer.from(narrow.clientId+':'+narrow.clientSecret).toString('base64'),{grant_type:'client_credentials',scope:'production:documents:read'},'synthetic-peer-2');
   const a=await identity.introspect(t.access_token);await assert.rejects(()=>reads.document(a,issued.documentId));assert.equal((await reads.documents(a,{})).items.length,0);
   await db.emissionPoint.update({where:{id:point},data:{active:false}});
   await identity.update('synthetic-admin',narrow.clientId,{revision:1,enabled:false,grants:grants.filter(g=>g.binding.series==='B991')});
   await assert.rejects(()=>identity.introspect(t.access_token),e=>e.code==='REVOKED_TOKEN');await db.emissionPoint.update({where:{id:point},data:{active:true}});
  });
  await check('SERVICE_GRE_SIGNED_AUDIT_AND_REVISION_GRANT_REVALIDATION',async()=>{
   // Reuse the pure reviewed fixture, through its compiled contract input fixture.
   const body={issueDate:new Date(Date.now()-60000).toISOString(),transferDate:new Date(Date.now()+86400000).toISOString().slice(0,10),reasonCode:'04',origin:{ubigeo:'150101',address:'FICTITIOUS ORIGIN',establishmentCode:'0001'},destination:{ubigeo:'150102',address:'FICTITIOUS DESTINATION',establishmentCode:'0002'},sender:{ruc,legalName:'ISOLATED SYNTHETIC ISSUER'},recipient:{ruc,legalName:'ISOLATED SYNTHETIC ISSUER'},grossWeight:'1.250',weightUnit:'KGM',transport:{mode:'02',vehicle:{plate:'ABC123',registration:'REG00001'},driver:{identityType:'1',identityNumber:'00000001',firstName:'FICTITIOUS',lastName:'DRIVER',license:'A000000001'}},items:[{code:'SYNTHETIC-ITEM',description:'FICTITIOUS GOODS',quantity:'2.000001',unitCode:'NIU'}],references:[],regulatedGoods:false};
   const n=await authority.resolve(actor,'production:guides:issue:09',bind('09'));
   const grant=await guides.configure(n.seriesId,{expectedVersion:0,actorKind:'SERVICE',actorId:actor.clientId,expectedClientRevision:actor.revision,enabled:true,profiles:['GRE09_PRIVATE04_V1'],expectedCredentialRevision:1,expiresAt:new Date(Date.now()+86400000).toISOString()},{userId:randomUUID(),scope:{kind:'GLOBAL'}});
   assert.equal(grant.actorId,nativeServicePrincipalId(actor.clientId));assert.equal(grant.createdByActor.revision,actor.revision);
   await guides.currentGrant(grant);serviceEnabled=false;await assert.rejects(()=>guides.currentGrant(grant));serviceEnabled=true;
   const ctx=commands.context(actor,n,authorization,randomUUID());const result=await guides.issueB2B({seriesCounterId:n.seriesId,profile:'GRE09_PRIVATE04_V1',body},ctx.operationId,ctx);
   const row=await db.document.findUnique({where:{id:result.documentId}});assert.equal(row.createdByUserId,null);assert.equal(row.createdByActor.clientId,actor.clientId);
   const event=await guides.event(row.id,{userId:randomUUID(),scope:{kind:'GLOBAL'}});assert.equal(event.snapshot.createdByActor.clientId,actor.clientId);await guides.current(event);
   serviceEnabled=false;await assert.rejects(()=>guides.current(event));serviceEnabled=true;
   assert.equal((await db.seriesCounter.findUnique({where:{id:n.seriesId}})).nextNumber,2n);
  });
  assert.ok(fiscalCalls>=2);
 }finally{await idDb.$disconnect();await idPool.end();}
});console.log(JSON.stringify({result:'PASS',groups,officialSunatCalls:0,customerDatabasesTouched:0}));}
main().catch(error=>{console.error(error);process.exitCode=1;});
