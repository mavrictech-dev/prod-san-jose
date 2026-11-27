'use strict';
// Real production hosts/guards/Identity/Prisma/PostgreSQL; disposable synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {main}=require('./native-gre-bootstrap.e2e.cjs');
assert.ok(process.argv[2]==='--isolated-synthetic-only');
const baseline=process.argv[3]==='--expect-unfixed',root=path.resolve(__dirname,'..');
const output=path.join(root,'output/gre-series-500-20261127',baseline?'baseline':'fixed');
async function run(){
 await main({output,work:async({http:directHttp,billingDb,identityDb,tokenFor,id,ruc,result,publicPorts,token})=>{
  const scenario=async gateway=>{
  const http=(side,url,...args)=>gateway&&side==='billing'&&url.startsWith('/api/v1/production-guides')?gateway(url,...args):directHttp(side,url,...args);
  const check=(v,name)=>{assert.ok(v,name);result.checks.push(name);};
  const uri='/api/v1/production-guides/series',body={pointId:id(3),series:'T099',expectedPointRevision:1};
  const post=async(value=body,auth)=>{const r=await http('billing',uri,'POST',value,auth);return {status:r.status,body:await r.json()};};
  const safe=[];
  const expectStatus=(r,status,name)=>{safe.push({name,status:r.status,code:r.body.code});fs.writeFileSync(path.join(output,'http-results.json'),JSON.stringify(safe,null,2)+'\n');check(r.status===status,name);if(status>=400)check(!JSON.stringify(r.body).match(/SELECT|INSERT|SeriesCounter_|stack|Prisma|Authorization/i),name+'-sanitized');};
  // Existing Beta counter and disabled grant must remain byte-for-byte unchanged.
  await billingDb.query(`INSERT INTO "SeriesCounter" (id,"companyId","emissionPointId","documentType",series,environment,"nextNumber","updatedAt") VALUES ($1,1,$2,'DESPATCH_ADVICE','T098','BETA',41,now())`,[id(98),id(3)]);
  await billingDb.query(`INSERT INTO "ProductionGuidesGrant" ("seriesCounterId","actorId",version,payload,"configuredBy") VALUES ($1,$2,1,'{"synthetic":true,"enabled":false}'::jsonb,$2)`,[id(98),id(1)]);
  const before=await billingDb.query('SELECT row_to_json(s) AS row FROM "SeriesCounter" s WHERE id=$1',[id(98)]);
  const grants=await billingDb.query('SELECT row_to_json(g) AS row FROM "ProductionGuidesGrant" g');
  const created=await post();expectStatus(created,201,'valid-T099-created');
  check(created.body.pointId===id(3)&&created.body.companyId===1&&created.body.series==='T099'&&created.body.nextNumber==='1'&&created.body.environment==='PRODUCTION','correct-point-company-environment-next-number');
  const listed=await (await http('billing','/api/v1/production-guides/series/point/'+id(3))).json();
  check(listed.series.some(s=>s.id===created.body.id&&s.issuerRuc===ruc&&s.grant===null&&s.nextNumber==='1'),'created-series-reread-without-grant');
  const duplicate=await post();expectStatus(duplicate,baseline?500:409,'duplicate-same-point');
  if(!baseline)check(duplicate.body.code==='GRE_SERIES_ALREADY_EXISTS'&&typeof duplicate.body.fieldErrors?.series==='string'&&duplicate.body.retryable===false,'duplicate-code-fieldErrors-through-filter-and-Kong');
  expectStatus(await post({...body,series:'T098'}),baseline?500:409,'existing-beta-series-conflict');
  expectStatus(await post({...body,pointId:'invalid'}),baseline?500:400,'invalid-point-uuid');
  const invalid=await post({...body,extra:true});expectStatus(invalid,baseline?500:400,'unknown-payload-field');
  if(!baseline)check(invalid.body.code==='GRE_SERIES_INVALID_REQUEST'&&typeof invalid.body.fieldErrors?.request==='string','invalid-code-fieldErrors-through-filter-and-Kong');
  expectStatus(await post({...body,series:'F099'}),400,'invalid-series-format');
  if(baseline){fs.writeFileSync(path.join(output,'http-results.json'),JSON.stringify(safe,null,2)+'\n');return;}
  expectStatus(await post(null),400,'null-payload');
  expectStatus(await post({...body,expectedPointRevision:-1}),400,'invalid-revision');
  expectStatus(await post({...body,series:'T100',expectedPointRevision:0}),409,'stale-point-CAS');
  // Real concurrent inserts use the database unique constraint without resetting a counter.
  const createdRow=(await billingDb.query('SELECT row_to_json(s) AS row FROM "SeriesCounter" s WHERE id=$1',[created.body.id])).rows;
  const race=await Promise.all([directHttp('billing',uri,'POST',{...body,series:'T100'}),directHttp('billing',uri,'POST',{...body,series:'T100'})]);
  assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);check(true,'concurrent-create-one-success-one-conflict');
  await billingDb.query(`INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,1,$2,'SECOND','SYNTHETIC SECOND',now())`,[id(13),id(2)]);
  expectStatus(await post({...body,pointId:id(13)}),409,'duplicate-other-point-same-company');
  // Uniqueness remains per company, preserving independent fiscal issuers.
  await billingDb.query(`INSERT INTO "CompanySettings" (id,ruc,"legalName","companyType","economicActivities","taxAddress",ubigeo,"contactEmails",environment,"updatedAt") VALUES (2,'20000000028','SECOND SYNTHETIC','SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],'BETA',now())`);
  await billingDb.query(`INSERT INTO "Branch" (id,"companyId",code,name,"establishmentCode") VALUES ($1,2,'SECOND','SECOND SYNTHETIC','0002')`,[id(22)]);
  await billingDb.query(`INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,2,$2,'SECOND-COMPANY','SECOND SYNTHETIC',now())`,[id(23),id(22)]);
  const second=await post({...body,pointId:id(23)});expectStatus(second,201,'same-series-independent-RUC');check(second.body.companyId===2&&second.body.pointId===id(23),'second-series-owned-by-second-company');
  expectStatus(await post({...body,pointId:id(999)}),403,'nonexistent-point');
  await billingDb.query('UPDATE "Branch" SET "establishmentCode"=NULL WHERE id=$1',[id(22)]);
  expectStatus(await post({...body,pointId:id(23),series:'T101'}),403,'missing-branch-establishment');
  await billingDb.query('UPDATE "Branch" SET "establishmentCode"=\'0002\',active=false WHERE id=$1',[id(22)]);
  expectStatus(await post({...body,pointId:id(23),series:'T101'}),403,'inactive-branch');
  // Tokens are signed only by this harness's ephemeral key and never written to evidence.
  for(const [name,claims,status]of [
   ['missing-permission',{permissions:['document.view']},403],['non-admin-invalid-global-scope',{roles:['CASHIER']},401],
   ['non-admin-assigned-scope',{roles:['CASHIER'],scope:{kind:'ASSIGNED',branchIds:[id(2)],emissionPointIds:[id(3)],series:[]}},403],
   ['admin-assigned-scope',{scope:{kind:'ASSIGNED',branchIds:[id(2)],emissionPointIds:[id(3)],series:[]}},403],
   ['service-kind',{kind:'SERVICE'},403],['service-actor-kind',{actorKind:'SERVICE'},403],['service-origin',{createdByActor:{kind:'SERVICE'}},403],
  ])expectStatus(await post({...body,series:'T102'},tokenFor(claims)),status,name);
  result.stage='real-PWA-Chrome-Kong-API-PG';await require('./helpers/gre-series-ui.cjs').seriesUi({root,output,request:gateway,id});check(true,'desktop-mobile-actual-series-API-through-Kong');result.stage='series-invariants';
  assert.deepEqual((await billingDb.query('SELECT row_to_json(s) AS row FROM "SeriesCounter" s WHERE id=$1',[id(98)])).rows,before.rows);check(true,'existing-counter-entire-row-preserved');
  assert.deepEqual((await billingDb.query('SELECT row_to_json(g) AS row FROM "ProductionGuidesGrant" g')).rows,grants.rows);check(true,'all-existing-grants-preserved');
  assert.deepEqual((await billingDb.query('SELECT row_to_json(s) AS row FROM "SeriesCounter" s WHERE id=$1',[created.body.id])).rows,createdRow);check(true,'created-T099-entire-row-preserved-through-conflicts-and-concurrency');
  check((await billingDb.query('SELECT count(*)::int AS n FROM "ProductionGuidesReservation"')).rows[0].n===0,'no-number-reservation');
  check((await billingDb.query('SELECT count(*)::int AS n FROM "Document"')).rows[0].n===0,'no-document-emission');
  check((await billingDb.query('SELECT count(*)::int AS n FROM "OutboxEvent"')).rows[0].n===0,'no-outbox-event');
  check((await billingDb.query('SELECT bool_and("nextNumber"=1) AS ok FROM "SeriesCounter" WHERE environment=\'PRODUCTION\'')).rows[0].ok,'new-counters-never-consumed');
  check((await billingDb.query('SELECT bool_and(environment=\'BETA\') AS ok FROM "CompanySettings"')).rows[0].ok,'sales-BETA-unchanged');
  // Execute the shipped read-only SQL itself against this disposable DB only.
  await billingDb.query('CREATE ROLE factuez_billing NOLOGIN');
  const ps=fs.readFileSync(path.join(root,'scripts/diagnose-gre-series.ps1'),'utf8'),sql=ps.match(/\$sql = @'\r?\n([\s\S]*?)\r?\n'@/)[1].replaceAll('20600979630',ruc);
  const metadataResults=await billingDb.query(sql),metadata=metadataResults.flatMap(r=>r.rows??[]).find(r=>r.json_build_object)?.json_build_object;
  check(metadata?.businessUniqueConstraintPresent===true&&metadata.billingCanInsertCounter===false&&metadata.companies?.[0]?.counters.some(c=>c.environment==='PRODUCTION'),'powershell-diagnostic-SQL-real-isolated-PG-valid-and-readonly');
  await identityDb.query('UPDATE "User" SET active=false,"authVersion"="authVersion"+1 WHERE id=$1',[id(1)]);
  expectStatus(await post({...body,series:'T103'}),401,'live-identity-revocation');
  fs.writeFileSync(path.join(output,'http-results.json'),JSON.stringify(safe,null,2)+'\n');
  };
  if(baseline)await scenario();else await require('./helpers/gre-series-kong.cjs').withSeriesKong({root,output,port:publicPorts.billing,token:tokenFor({exp:Math.floor(Date.now()/1000)+3600})},scenario);
 }});
 const report=JSON.parse(fs.readFileSync(path.join(output,'bootstrap-results.json')));assert.deepEqual(report.failures,[],'GRE_SERIES_REGISTRATION_FAILED');
}
run().catch(()=>{console.error('SYNTHETIC_GRE_SERIES_REGISTRATION_FAILED');process.exitCode=1;});
