'use strict';
const assert=require('node:assert/strict'),{generateKeyPairSync,randomBytes,randomUUID}=require('node:crypto');
const {withCorrectionAuthorityDatabases}=require('./helpers/correction-authority-db.cjs');
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--isolated-synthetic-only']))throw new Error('ISOLATED_SYNTHETIC_ONLY_REQUIRED');
const passed=[];let stage='PREFLIGHT';
withCorrectionAuthorityDatabases(async({billingClient,identityClient,billingPool,identityPool,b,i})=>{
  const {B2bIdentity}=i('./dist/b2b/service'),{B2bTokenCodec}=i('./dist/b2b/token'),{PostgresB2bStore}=i('./dist/b2b/postgres-store');
  const {B2bCorrectionAuthority,correctionScopes}=i('./dist/b2b/correction-authority'),{PostgresB2bCorrectionStore}=i('./dist/b2b/correction-store');
  const {PostgresLinkedUsers}=i('./dist/b2b/users'),{PostgresQueuedUsers}=i('./dist/b2b/webhook-authority');
  const {B2bCorrectionCatalogue,PrismaB2bCorrectionPairRepository}=b('./dist/b2b/correction-catalogue'),{PrismaB2bContextRepository,B2bContextService}=b('./dist/b2b/context');
  const {B2bEnabledIdentityScopes}=b('@factuez/contracts/b2b-security');
  const branch=randomUUID(),point=randomUUID(),original=randomUUID(),note=randomUUID(),debit=randomUUID(),other=randomUUID(),userId=randomUUID(),adminId=randomUUID();
  const pair={reference:{issuerId:1,issuerRuc:'00000000001',environment:'BETA',branchId:branch,pointId:point,seriesId:original,documentType:'01'},noteSeriesId:note,noteType:'07'};
  const ctx=()=>({requestId:randomUUID(),peer:'SYNTHETIC-CORRECTION-DB'}),check=async(label,work)=>{stage=label;await work();passed.push(label);};
  await billingPool.query(`INSERT INTO "CompanySettings" ("id","ruc","legalName","companyType","economicActivities","taxAddress","ubigeo","contactEmails","environment","updatedAt") VALUES (1,'00000000001','SYNTHETIC ONLY','QA','{}','SYNTHETIC ADDRESS','150101','{}','BETA',now());
    INSERT INTO "Branch" ("id","companyId","code","name") VALUES ('${branch}',1,'QA','SYNTHETIC ONLY');
    INSERT INTO "EmissionPoint" ("id","companyId","branchId","code","name","updatedAt") VALUES ('${point}',1,'${branch}','QA','SYNTHETIC ONLY',now()),('${other}',1,'${branch}','QA_OTHER','SYNTHETIC ONLY',now());
    INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series","nextNumber","updatedAt") VALUES ('${original}',1,'${point}','INVOICE','F001',1,now()),('${note}',1,'${point}','CREDIT_NOTE','FC01',1,now()),('${debit}',1,'${point}','DEBIT_NOTE','FD01',1,now());`);
  await identityClient.user.create({data:{id:userId,username:'synthetic_user',fullName:'SYNTHETIC ONLY',passwordHash:'SYNTHETIC-NOT-A-LOGIN',authVersion:3}});
  const pairKeys=generateKeyPairSync('rsa',{modulusLength:2048}),otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'});
  const codec=new B2bTokenCodec(Buffer.from(pairKeys.privateKey.export({type:'pkcs8',format:'pem'})),'https://synthetic-identity.invalid',()=>1800000000,{human:Buffer.from(otherKey),integration:Buffer.from(otherKey),tls:Buffer.from(otherKey)});
  const admin={verify:async token=>{assert.equal(token,'synthetic-step-up');return {id:adminId,stepUpVerified:true};}};
  const context=new B2bContextService(new PrismaB2bContextRepository(billingClient),{});
  const catalogue=new B2bCorrectionCatalogue(new PrismaB2bCorrectionPairRepository(billingClient));
  const normal=new PostgresB2bStore(identityClient),store=new PostgresB2bCorrectionStore(identityClient);
  let delegated=null;const identity=new B2bIdentity(normal,codec,randomBytes(32),admin,{validate:values=>context.validate(values)}, {verify:async()=>structuredClone(delegated)},()=>1800000000000,B2bEnabledIdentityScopes);
  const linked=new PostgresLinkedUsers(identityClient,{effective:async()=>[]}),users=new PostgresQueuedUsers(identityClient,linked);
  const authority=new B2bCorrectionAuthority(store,identity,{validate:async values=>{await catalogue.validate(values);}},admin,users);
  const made=await identity.create('synthetic-step-up',{label:'SYNTHETIC SERVICE',kind:'SERVICE',scopes:[...correctionScopes],bindings:[pair.reference]},ctx());
  const access=async secret=>(await identity.token('Basic '+Buffer.from(made.client.id+':'+secret).toString('base64'),{grant_type:'client_credentials',scope:correctionScopes.join(' ')},ctx())).access_token;
  let token=await access(made.clientSecret);
  const authorize=()=>authority.authorize(token,{kind:'SERVICE',binding:pair},ctx());
  const replace=(bindings=[pair],grant=0,client=1)=>authority.replace('synthetic-step-up',made.client.id,{bindings,expectedClientRevision:client,expectedGrantRevision:grant},ctx());
  await check('NO_DEFAULT_GRANT_OR_FISCAL_SIDE_EFFECT',async()=>{await assert.rejects(authorize(),e=>e.status===404);assert.equal(await billingClient.document.count(),0);assert.equal(await billingClient.outboxEvent.count(),0);});
  await check('PERSISTENT_PAIRED_GRANT_AND_RESTART_ACTUAL_JWT',async()=>{
    await replace();const restarted=new B2bCorrectionAuthority(new PostgresB2bCorrectionStore(identityClient),identity,{validate:values=>catalogue.validate(values)},admin,users);
    const r=await restarted.authorize(token,{kind:'SERVICE',binding:pair},ctx());assert.equal(r.actor.userId,null);assert.equal(r.grantRevision,1);assert.equal(r.transmissionAuthorized,false);
    assert.equal((await identityPool.query('SELECT count(*)::int n FROM "B2bCorrectionGrantRevision"')).rows[0].n,1);
  });
  await check('CONCURRENT_GRANT_EDIT_EXACTLY_ONE_WINNER',async()=>{
    const results=await Promise.allSettled([replace([pair],1),replace([],1)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.status===409).length,1);
    await replace([pair],2);
  });
  await check('CROSS_POINT_TYPE_FAMILY_RUC_AND_DISABLED_CANONICAL_RESOURCES',async()=>{
    for(const candidate of [{...pair,noteType:'08'},{...pair,noteSeriesId:debit},{...pair,reference:{...pair.reference,issuerRuc:'00000000002'}}])await assert.rejects(catalogue.validate([candidate]),e=>e.status===400);
    await billingClient.seriesCounter.update({where:{id:note},data:{emissionPointId:other}});await assert.rejects(authorize(),e=>e.status===400);await billingClient.seriesCounter.update({where:{id:note},data:{emissionPointId:point}});
    for(const [table,id]of [['branch',branch],['emissionPoint',point],['seriesCounter',note],['companySettings',1]]){
      await billingClient[table].update({where:{id},data:{active:false}});await assert.rejects(authorize(),e=>e.status===400);await billingClient[table].update({where:{id},data:{active:true}});
    }
    await billingClient.seriesCounter.update({where:{id:note},data:{series:'BC01'}});await assert.rejects(authorize(),e=>e.status===400);await billingClient.seriesCounter.update({where:{id:note},data:{series:'FC01'}});
  });
  await check('REVISION_HISTORY_IMMUTABLE_AND_HEAD_MONOTONIC',async()=>{
    await assert.rejects(identityPool.query('UPDATE "B2bCorrectionGrantRevision" SET "bindings"=\'[]\'::jsonb WHERE "clientId"=$1',[made.client.id]));
    await assert.rejects(identityPool.query('DELETE FROM "B2bCorrectionGrantRevision" WHERE "clientId"=$1',[made.client.id]));
    await assert.rejects(identityPool.query('UPDATE "B2bCorrectionGrantHead" SET "revision"=1 WHERE "clientId"=$1',[made.client.id]));
    await assert.rejects(identityPool.query('DELETE FROM "B2bCorrectionGrantHead" WHERE "clientId"=$1',[made.client.id]));
  });
  await check('AUDIT_FAILURE_ROLLS_BACK_HEAD_AND_APPEND_ONLY_REVISION',async()=>{
    await identityPool.query(`CREATE FUNCTION synthetic_reject_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action"='REPLACE_CORRECTION_GRANTS' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$; CREATE TRIGGER synthetic_audit BEFORE INSERT ON "B2bAudit" FOR EACH ROW EXECUTE FUNCTION synthetic_reject_grant_audit();`);
    await assert.rejects(replace([],3),e=>e.status===503);
    assert.equal((await identityPool.query('SELECT "revision" FROM "B2bCorrectionGrantHead" WHERE "clientId"=$1',[made.client.id])).rows[0].revision,3);
    assert.equal((await identityPool.query('SELECT count(*)::int n FROM "B2bCorrectionGrantRevision" WHERE "clientId"=$1',[made.client.id])).rows[0].n,3);
    await identityPool.query('DROP TRIGGER synthetic_audit ON "B2bAudit"; DROP FUNCTION synthetic_reject_grant_audit();');
  });
  await check('CLIENT_ROTATION_REQUIRES_EXPLICIT_REGRANT_FOR_NEW_REVISION',async()=>{
    const changed=await identity.change('synthetic-step-up',made.client.id,{expectedRevision:1},ctx(),true);await assert.rejects(authorize(),e=>e.status===401);
    token=await access(changed.clientSecret);await assert.rejects(authorize(),e=>e.status===404);
    await replace([pair],3,2);assert.equal((await authorize()).grantRevision,4);
    await replace([],4,2);await assert.rejects(authorize(),e=>e.status===404);
  });
  await check('REAL_USER_LINK_LOCAL_PERMISSIONS_AND_NOTE_ASSIGNMENT',async()=>{
    const role=await identityClient.role.create({data:{code:'CASHIER',name:'SYNTHETIC ONLY'}});
    for(const code of ['DOCUMENT_VIEW','DOCUMENT_ISSUE']){const permission=await identityClient.permission.create({data:{code,name:'SYNTHETIC ONLY'}});await identityClient.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});}
    await identityClient.userRoleAssignment.create({data:{userId,roleId:role.id,assignedByUserId:userId}});
    await identityClient.userBranch.create({data:{userId,branchId:branch}});await identityClient.userEmissionPoint.create({data:{userId,emissionPointId:point,assignedByUserId:userId}});
    await identityClient.userSeries.createMany({data:[{userId,series:original},{userId,series:note}]});
    const u=await identity.create('synthetic-step-up',{label:'SYNTHETIC USER',kind:'USER',oidcClientId:'synthetic_oidc',scopes:[...correctionScopes],bindings:[pair.reference]},ctx());
    await identityPool.query(`INSERT INTO "B2bUserLink" ("issuer","subject","oidcClientId","clientId","clientRevision","userId","userAuthRevision","enabled") VALUES ('https://synthetic.invalid','synthetic-sub','synthetic_oidc',$1,1,$2,3,true)`,[u.client.id,userId]);
    delegated={clientId:u.client.id,clientRevision:1,oidcClientId:'synthetic_oidc',userId,authRevision:3,tokenScopes:[...correctionScopes],permissions:['document.view','document.issue'],scope:{kind:'ASSIGNED',branchIds:[branch],emissionPointIds:[point],series:[original]}};
    await authority.replace('synthetic-step-up',u.client.id,{expectedClientRevision:1,expectedGrantRevision:0,bindings:[pair]},ctx());
    const auth=()=>authority.authorize('synthetic-oidc-token',{kind:'USER',binding:pair},ctx());assert.equal((await auth()).actor.userId,userId);
    await identityClient.userSeries.deleteMany({where:{userId,series:note}});await assert.rejects(auth(),e=>e.status===404);await identityClient.userSeries.create({data:{userId,series:note}});
    await identityPool.query('UPDATE "B2bUserLink" SET "enabled"=false WHERE "clientId"=$1',[u.client.id]);await assert.rejects(auth(),e=>e.status===404);
    await identityPool.query('UPDATE "B2bUserLink" SET "enabled"=true WHERE "clientId"=$1',[u.client.id]);await identityClient.user.update({where:{id:userId},data:{authVersion:4}});await assert.rejects(auth(),e=>e.status===404);
  });
  await check('INVOICE_CREDIT_DEBIT_AND_BOLETA_PERMISSIONS_ARE_EXPLICIT',async()=>{
    const receipt=randomUUID(),receiptCredit=randomUUID();
    await billingClient.seriesCounter.createMany({data:[
      {id:receipt,companyId:1,emissionPointId:point,documentType:'SALES_RECEIPT',series:'B001'},
      {id:receiptCredit,companyId:1,emissionPointId:point,documentType:'CREDIT_NOTE',series:'BC01'},
    ]});
    const debitPair={...pair,noteSeriesId:debit,noteType:'08'},receiptPair={reference:{...pair.reference,seriesId:receipt,documentType:'03'},noteSeriesId:receiptCredit,noteType:'07'};
    const app=await identity.create('synthetic-step-up',{label:'SYNTHETIC MULTI PAIR',kind:'SERVICE',scopes:[...correctionScopes],bindings:[pair.reference,receiptPair.reference]},ctx());
    const jwt=(await identity.token('Basic '+Buffer.from(app.client.id+':'+app.clientSecret).toString('base64'),{grant_type:'client_credentials',scope:correctionScopes.join(' ')},ctx())).access_token;
    const authorizePair=binding=>authority.authorize(jwt,{kind:'SERVICE',binding},ctx());
    await assert.rejects(authorizePair(pair),e=>e.status===404);
    await authority.replace('synthetic-step-up',app.client.id,{expectedClientRevision:1,expectedGrantRevision:0,bindings:[pair,debitPair,receiptPair]},ctx());
    for(const binding of [pair,debitPair,receiptPair]){const r=await authorizePair(binding);assert.deepEqual(r.binding,binding);assert.equal(r.actor.scope.series.length,2);}
    await assert.rejects(authorizePair({...pair,noteSeriesId:receiptCredit}),e=>e.status===404);
  });
  await check('ALL_FAILURES_LEAVE_BILLING_HISTORY_NUMBERS_AND_OUTBOX_UNTOUCHED',async()=>{
    assert.equal(await billingClient.document.count(),0);assert.equal(await billingClient.outboxEvent.count(),0);
    assert.ok((await billingClient.seriesCounter.findMany()).every(row=>row.nextNumber===1n));
    const audits=(await identityPool.query('SELECT "actorId","action","outcome" FROM "B2bAudit" WHERE "action"=\'AUTHORIZE_CORRECTION_PAIR\'')).rows;
    assert.ok(audits.some(r=>r.actorId===null&&r.outcome==='OK'));assert.ok(audits.some(r=>r.actorId===userId&&r.outcome==='DENIED'));
  });
}).then(()=>{console.log(JSON.stringify({result:'PASS',checks:passed.length,groups:passed,syntheticOnly:true,ownerDatabases:2,qaTouched:false,fiscalExecution:false}));}).catch(()=>{console.error(JSON.stringify({result:'FAIL',stage,passed:passed.length,syntheticOnly:true,qaTouched:false}));process.exitCode=1;});
