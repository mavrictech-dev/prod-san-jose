import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:https';
import {createHash,randomBytes,X509Certificate} from 'node:crypto';
import {purchaseSnapshot,purchaseCatalogue} from './production-guides-purchase.fixture';
import {seals,uuid,now,tlsFixture} from './production-guides.fixture';
import {ProductionGuidesRest,ProductionGuidesHttps} from '../services/sunat-service/src/production-guides-transport';
import {productionTransportXml} from '../services/sunat-service/src/infrastructure/sunat/production-transport-zip';
import {buildProductionGuidesXml,productionGuidesHash as hash,PRODUCTION_GUIDES_XSD_SHA256} from '../packages/sunat-core/src/production-guides';
import {ProductionGuidesOwner} from '../services/billing-service/src/production-guides-owner';
import {ProductionGuidesBillingRuntime} from '../services/billing-service/src/production-guides-runtime';
import {ProductionGuidesStore} from '../services/sunat-service/src/production-guides-store';
import {ProductionGuidesService} from '../services/sunat-service/src/production-guides-service';
import {ProductionGuidesCatalogueRules,ProductionGuidesVaultSecrets} from '../services/sunat-service/src/production-guides-crypto';
import {validateOfficialGreXml} from '../services/sunat-service/src/production-guides-official-rules';
import {signLocalGuideXml} from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import {createGuideSidecarPki,guideSidecarCdrXml,guideSidecarPackCdr} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {renderProductionGuidesPdf} from '../services/sunat-service/src/production-guides-pdf';
import {SecretVault} from '../services/sunat-service/src/infrastructure/crypto/secret-vault';
import {IssuanceQueryService} from '../services/billing-service/src/application/issuance-query.service';
import {IssueDocumentService} from '../services/billing-service/src/application/issue-document.service';
import {NativeB2bBillingAuthority} from '../services/billing-service/src/native-b2b-authority';
import {StationAdminService} from '../services/billing-service/src/application/station-admin.service';
const local=createRequire(import.meta.url),{withCorrectionDatabase}=local('./helpers/correction-reservation-db.cjs');
describe('GRE production onboarding from business sales BETA, isolated PostgreSQL',()=>{
 it('keeps sales Beta, history, counters and sales gates intact while independent GRE completes real local HTTP/HTTPS',async()=>withCorrectionDatabase(async({pool,client}:any)=>{
  for(const f of ['services/billing-service/prisma/production-guides.sql','services/sunat-service/prisma/production-guides.sql','services/billing-service/prisma/updates/20261124_gre_hydrocarbon_v1.sql'])await pool.query(readFileSync(resolve(f),'utf8'));
  for(const flag of ['NATIVE_GRE_ENABLED','NATIVE_GRE_WORKERS_ENABLED','BILLING_PRODUCTION_ISSUANCE_ENABLED','BILLING_PRODUCTION_NOTES_ENABLED','SUNAT_PRODUCTION_WORKFLOW_ENABLED'])vi.stubEnv(flag,'false');
  vi.stubEnv('STATION_MASTER_CRUD_ENABLED','true');
  const greEnabled=()=>process.env.NATIVE_GRE_ENABLED==='true'&&process.env.NATIVE_GRE_WORKERS_ENABLED==='true';
  const s=purchaseSnapshot(),b=s.body as any,c=purchaseCatalogue(s),k=seals(),pki=createGuideSidecarPki(s.issuer.ruc),actor={userId:s.actorId,scope:{kind:'GLOBAL' as const}};
  await pool.query(`INSERT INTO "CompanySettings" (id,ruc,"legalName","companyType","economicActivities","taxAddress",ubigeo,"contactEmails",environment,"updatedAt") VALUES (1,$1,$2,'SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],'BETA',now())`,[s.issuer.ruc,s.issuer.legalName]);
  await pool.query(`INSERT INTO "Branch" (id,"companyId",code,name,"establishmentCode") VALUES ($1,1,'SYNTHETIC','SYNTHETIC','0001')`,[s.scope.branchId]);
  await pool.query(`INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,1,$2,'SYNTHETIC','SYNTHETIC',now())`,[s.scope.pointId,s.scope.branchId]);
  await pool.query(`INSERT INTO "CompanySettings" (id,ruc,"legalName","companyType","economicActivities","taxAddress",ubigeo,"contactEmails",environment,"updatedAt") VALUES (2,'20000000028','OTHER SYNTHETIC','SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],'PRODUCTION',now())`);
  await pool.query(`INSERT INTO "Branch" (id,"companyId",code,name,"establishmentCode") VALUES ($1,2,'OTHER','OTHER','0001')`,[uuid(670)]);
  await pool.query(`INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,2,$2,'OTHER','OTHER',now())`,[uuid(671),uuid(670)]);
  const query=new IssuanceQueryService(client);expect((await query.catalog(actor.scope)).companies.map(c=>c.id)).toEqual([1]);
  const betaGuideId=s.scope.seriesCounterId,betaInvoiceId=uuid(660),prodInvoiceId=uuid(661);
  await pool.query(`INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType",series,environment,"nextNumber","updatedAt") VALUES ($1,1,$2,'DESPATCH_ADVICE','T991','BETA',41,now()),($3,1,$2,'INVOICE','F990','BETA',9,now()),($4,1,$2,'INVOICE','F991','PRODUCTION',7,now())`,[betaGuideId,s.scope.pointId,betaInvoiceId,prodInvoiceId]);
  await pool.query(`INSERT INTO "Document" (id,"companyId","seriesCounterId",type,status,series,number,"fullNumber","issueDate","emissionPointId","customerIdentityType","customerIdentityNumber","customerLegalName","taxableAmount","igvAmount","payableAmount","immutableSnapshot","updatedAt") VALUES ($1,1,$2,'INVOICE','ISSUED','F990',8,'F990-8',now(),$3,'6',$4,'SYNTHETIC',0,0,0,'{"environment":"BETA","synthetic":true}',now())`,[uuid(662),betaInvoiceId,s.scope.pointId,s.issuer.ruc]);
  const historical=(await pool.query('SELECT row_to_json(d) AS value FROM "Document" d WHERE id=$1',[uuid(662)])).rows[0].value;
  await pool.query(`INSERT INTO "ProductUnit" (code,description) VALUES ('GLL','SYNTHETIC')`);
  for(const [i,item]of b.items.entries())await pool.query(`INSERT INTO "FuelProduct" (id,sku,description,category,"unitCode","taxAffectationCode","greGoodsFamily","updatedAt") VALUES ($1,$2,$3,'SYNTHETIC',$4,'10',$5,now())`,[uuid(701+i),item.code,item.description,item.unitCode,b.hydrocarbon.items[i].family]);
  const pins={credentialRevision:1,certificateFingerprint:pki.issuer.fingerprint,rulesSha256:hash(c),xsdSha256:PRODUCTION_GUIDES_XSD_SHA256};
  const vaultKey=randomBytes(32),vault=new SecretVault(vaultKey),secrets=new ProductionGuidesVaultSecrets(client,vault);
  await pool.query(`CREATE TABLE "SunatCredentials" ("issuerRuc" text,environment text,revision integer,"certificateFingerprint" text,"certificateExpiresAt" timestamptz,"certificateSelfSigned" boolean,"certificateCipher" text,"certificatePasswordCipher" text,"greClientIdCipher" text,"greClientSecretCipher" text,"solUsernameCipher" text,"solPasswordCipher" text,PRIMARY KEY("issuerRuc",environment))`);
  const provision=async(environment='PRODUCTION')=>{
   const fields:[string,string|Buffer][]=[['certificate',pki.issuer.pkcs12],['certificatePassword',pki.password],['greClientId','SYNTHETIC'],['greClientSecret','SYNTHETIC_GRE'],['solUsername','SECONDARY'],['solPassword','SYNTHETIC_SOL']];
   const encrypted=fields.map(([field,value])=>vault.seal(value,{ruc:s.issuer.ruc,environment,field}));
   await pool.query(`INSERT INTO "SunatCredentials" VALUES ($1,$2,1,$3,$4,false,$5,$6,$7,$8,$9,$10)`,[s.issuer.ruc,environment,pki.issuer.fingerprint,new X509Certificate(pki.issuer.certificatePem).validTo,...encrypted]);
  };
  await provision();expect((await pool.query(`SELECT count(*)::int n FROM "SunatCredentials" WHERE environment='BETA'`)).rows[0].n).toBe(0);
  const signed=async(snapshot:any,g:any,xml:string)=>secrets.withCertificate(g,async(bytes,password)=>{const r=signLocalGuideXml({issuerRuc:snapshot.issuer.ruc,documentType:'09',fullNumber:`${snapshot.series}-${snapshot.number}`,unsignedXml:xml},bytes,password);return {xml:Buffer.from(r.xml),zip:r.zip,xmlSha256:r.xmlSha256,zipSha256:r.zipSha256,fingerprint:r.certificateFingerprintSha256,digest:r.digestValue};});
  let service:ProductionGuidesService,active=true,throwPost=false,failCdr=false,crlExpired=false,tamperCdr=false;let currentNumber='1',oauthCount=0;
  const owner=new ProductionGuidesOwner(client,{enabled:greEnabled,signer:k.ownerSigner,ownerVerifier:k.verifier,statusVerifier:k.verifier,actorCurrent:async()=>({scope:actor.scope,active,canIssue:true}),sunat:{grantEvidence:async(scope,_profiles,revision)=>({...pins,...await secrets.configuration(scope.issuerRuc,revision)}),admit:(s,g)=>service.admit(s,g),status:e=>service.status(e),artifact:(e,a)=>service.artifact(e,a),pdf:e=>service.pdf(e)},now:()=>now});
  const store=new ProductionGuidesStore(client,k.statusSigner,'LOCAL_SYNTHETIC'),submit=vi.fn(async()=>{if(throwPost)throw Error('SYNTHETIC_RESPONSE_LOST_AFTER_POST');return {ticket:uuid(799+Number(currentNumber))};});
  const tls=tlsFixture(),server=createServer({key:tls.key,cert:tls.cert},async(req,res)=>{
   try{
    const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));const bytes=Buffer.concat(chunks);res.setHeader('Content-Type','application/json');
    if(req.url?.includes('/oauth2/')){oauthCount++;const form=new URLSearchParams(bytes.toString());expect(form.get('client_secret')).toBe('SYNTHETIC_GRE');expect(form.get('password')).toBe('SYNTHETIC_SOL');return void res.end(JSON.stringify({access_token:'SYNTHETIC_TOKEN',token_type:'Bearer',expires_in:3600}));}
    expect(req.headers.authorization).toBe('Bearer SYNTHETIC_TOKEN');
    if(req.method==='POST'){
     const archive=JSON.parse(bytes.toString()).archivo,zip=Buffer.from(archive.arcGreZip,'base64');expect(createHash('sha256').update(zip).digest('hex')).toBe(archive.hashZip);
     const xml=productionTransportXml(zip,archive.nomArchivo.replace(/\.zip$/,'.xml')).xml.toString();expect(xml).toContain('<cac:SellerSupplierParty>');expect(xml).toContain('10000000001');expect(xml).toContain('10000000002');
     return void res.end(JSON.stringify({numTicket:(await submit()).ticket}));
    }
    const expected={issuerRuc:s.issuer.ruc,documentType:'09' as const,fullNumber:'T992-'+currentNumber,requestXmlSha256:'a'.repeat(64),requestZipSha256:'b'.repeat(64),issuedAt:b.issueDate,receivedAt:now};
    let signed=pki.signCdr(guideSidecarCdrXml(expected).replace('FICTITIOUS LOCAL RECEIPT','<![CDATA[SYNTHETIC PURCHASE RECEIPT]]>'));
    if(tamperCdr)signed=signed.replace('SYNTHETIC PURCHASE RECEIPT','SYNTHETIC ALTERED RECEIPT');
    res.end(JSON.stringify({codRespuesta:'0',indCdrGenerado:'1',arcCdr:guideSidecarPackCdr(signed,expected).toString('base64')}));
   }catch{res.destroy();}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`https://127.0.0.1:${(server.address() as any).port}`;
  const transport=new ProductionGuidesRest({http:new ProductionGuidesHttps({origin,ca:tls.ca}),syntheticOrigin:origin,authorize:async(_action,g)=>{await owner.currentGrant(g);},credentials:secrets});
  let app:any,restoreControllerGuards:(()=>void)|undefined;
  try{
  const options={enabled:greEnabled,owner:{current:(e:any)=>owner.current(e),reference09:async()=>{throw Error('UNUSED');}},referenceOwner:(s:any)=>owner.referenceOwner(s),ownerVerifier:k.verifier,crypto:{ready:async(snapshot:any,g:any)=>{if(crlExpired)throw Error('SYNTHETIC_EXPIRED_CRL');await new ProductionGuidesCatalogueRules(c).validate(snapshot,g);await secrets.inspect(g);const signedXml=(await signed(snapshot,g,buildProductionGuidesXml(snapshot).xml)).xml.toString();await validateOfficialGreXml(signedXml,`${s.issuer.ruc}-09-T992-${snapshot.number}.xml`);},sign:async(snapshot:any,g:any,xml:string)=>signed(snapshot,g,xml)},transport,cdr:{verify:(bytes:Buffer)=>failCdr?Promise.resolve(false):pki.cdrVerifier.verify(bytes)},pdf:renderProductionGuidesPdf,now:()=>now};
  service=new ProductionGuidesService(store,options);
  // Actual installed public controller and Nest HTTP handler, with an explicit
  // test-only auth guard. Real JWT/Identity/mTLS revocation has its own host test.
  const billing=createRequire(resolve('services/billing-service/package.json'));
  const {NestFactory}=billing('@nestjs/core'),{Module,UnauthorizedException}=billing('@nestjs/common');
  const {ProductionGuidesBillingController}=billing('./dist/production-guides.controller'),{ProductionGuidesOwner:OwnerToken}=billing('./dist/production-guides-owner');
  const originalGuards=Reflect.getMetadata('__guards__',ProductionGuidesBillingController);
  const syntheticGuard={canActivate:(context:any)=>{const req=context.switchToHttp().getRequest();if(req.headers.authorization!=='Bearer SYNTHETIC_NATIVE')throw new UnauthorizedException();req.user={sub:s.actorId,roles:['ADMIN'],permissions:['document.issue','document.view','sunat.configure'],scope:actor.scope};return true;}};
  Reflect.defineMetadata('__guards__',[syntheticGuard],ProductionGuidesBillingController);restoreControllerGuards=()=>Reflect.defineMetadata('__guards__',originalGuards,ProductionGuidesBillingController);
  class SyntheticPurchaseModule{}
  Module({controllers:[ProductionGuidesBillingController],providers:[{provide:OwnerToken,useValue:owner}]})(SyntheticPurchaseModule);
  app=await NestFactory.create(SyntheticPurchaseModule,{logger:false});await app.listen(0,'127.0.0.1');const publicOrigin=await app.getUrl();
  const api=(path:string,body?:unknown,key?:string)=>fetch(publicOrigin+'/api/v1/production-guides'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer SYNTHETIC_NATIVE','Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
  expect((await fetch(publicOrigin+'/api/v1/production-guides?pointId='+s.scope.pointId)).status).toBe(401);
  const seriesRequest={pointId:s.scope.pointId,series:'T992',expectedPointRevision:1};
  expect((await api('/series',seriesRequest)).status).toBe(503);
  await expect(owner.issue({seriesCounterId:betaGuideId,profile:s.profile,body:b},uuid(700),actor)).rejects.toThrow();expect(submit).not.toHaveBeenCalled();
  vi.stubEnv('NATIVE_GRE_ENABLED','true');expect((await api('/series',seriesRequest)).status).toBe(503);
  vi.stubEnv('NATIVE_GRE_WORKERS_ENABLED','true');
  expect((await query.catalog(actor.scope)).companies.map(c=>c.id).sort()).toEqual([1,2]);
  const assigned={kind:'ASSIGNED' as const,branchIds:[s.scope.branchId],emissionPointIds:[s.scope.pointId],series:[betaGuideId]};
  const scoped=await query.catalog(assigned);expect(scoped.companies.map(c=>c.id)).toEqual([1]);expect(scoped.emissionPoints.map(p=>p.id)).toEqual([s.scope.pointId]);expect(scoped.capabilities.productionInvoiceAdmission).toBe(false);
  await expect(owner.capabilities(uuid(671),{...actor,scope:assigned})).rejects.toThrow();
  await expect(new StationAdminService(client).configureEnvironment('1',{}, {headers:{},user:{sub:s.actorId,roles:['ADMIN'],permissions:['setup.manage','sunat.configure'],scope:actor.scope}} as any)).rejects.toThrow(/bloqueada/);
  await expect(owner.createSeries(seriesRequest,{...actor,scope:{kind:'ASSIGNED',branchIds:[s.scope.branchId],emissionPointIds:[s.scope.pointId],series:[]}})).rejects.toThrow('ADMIN_GLOBAL');
  const created=await api('/series',seriesRequest);expect(created.status).toBe(201);const counter=await created.json();expect(counter.environment).toBe('PRODUCTION');s.scope.seriesCounterId=counter.id;s.series='T992';
  await expect(owner.configure(betaGuideId,{expectedVersion:0,actorId:actor.userId,enabled:true,profiles:[s.profile],expectedCredentialRevision:1,expiresAt:'2026-12-31T00:00:00Z'},actor)).rejects.toThrow();
  const grant={expectedVersion:0,actorId:actor.userId,enabled:true,profiles:['GRE09_PRIVATE04_V1'],expectedCredentialRevision:1,expiresAt:'2026-12-31T00:00:00Z'};
  await owner.configure(s.scope.seriesCounterId,grant,actor);
  const request={seriesCounterId:s.scope.seriesCounterId,profile:s.profile,body:b};
  await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow('Concesión');
  expect((await api('/series/'+s.scope.seriesCounterId+'/grants',{...grant,expectedVersion:1,profiles:[s.profile]})).status).toBe(201);
  await provision('BETA');await pool.query(`DELETE FROM "SunatCredentials" WHERE environment='PRODUCTION'`);
  await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow('GRE_CREDENTIAL');expect(submit).not.toHaveBeenCalled();await provision();await pool.query(`DELETE FROM "SunatCredentials" WHERE environment='BETA'`);
  await pool.query(`UPDATE "SunatCredentials" SET revision=2 WHERE environment='PRODUCTION'`);await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow('GRE_CREDENTIAL');await pool.query(`UPDATE "SunatCredentials" SET revision=1 WHERE environment='PRODUCTION'`);
  await expect(owner.issue({...request,body:{...b,sender:{...b.sender,ruc:'20000000028'}}},uuid(700),actor)).rejects.toThrow();
  const grantStatus=await owner.capabilities(s.scope.pointId,actor);expect(grantStatus).toMatchObject({environment:'PRODUCTION',greServiceEnvironment:'PRODUCTION',salesEnvironment:'BETA'});
  await expect(owner.issue({...request,seriesCounterId:betaGuideId},uuid(700),actor)).rejects.toThrow();
  await pool.query('UPDATE "CompanySettings" SET ruc=$1 WHERE id=1',['00000000001']);await expect(owner.createSeries({...seriesRequest,series:'V992'},actor)).rejects.toThrow('RUC');await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow();await pool.query('UPDATE "CompanySettings" SET ruc=$1 WHERE id=1',[s.issuer.ruc]);
  expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter" WHERE id=$1',[counter.id])).rows[0].nextNumber).toBe('1');
  expect((await pool.query('SELECT count(*)::int n FROM "ProductionGuidesReservation"')).rows[0].n).toBe(0);expect((await pool.query('SELECT count(*)::int n FROM "OutboxEvent"')).rows[0].n).toBe(0);
  const invoice={emissionPointId:s.scope.pointId,documentType:'INVOICE' as const,series:'F991',issueDate:now,currencyCode:'PEN' as const,paymentTerms:{type:'CONTADO' as const},customer:{identityType:'6',identityNumber:s.issuer.ruc,legalName:'SYNTHETIC'},lines:[{description:'SYNTHETIC',unitCode:'NIU',quantity:'1',unitPriceWithTax:'1.18',taxAffectationCode:'10',igvRate:'18'}]};
  const salesContext={userId:s.actorId,scope:actor.scope,idempotencyKey:'SYNTHETIC-SALES-PROD',authorization:'Bearer SYNTHETIC_NATIVE'};
  const sales=new IssueDocumentService(client);await expect(sales.executeWithinTransaction(invoice as any,salesContext,client)).rejects.toThrow(/otro ambiente/);
  await pool.query(`UPDATE "CompanySettings" SET environment='PRODUCTION' WHERE id=1`);await expect(sales.executeWithinTransaction(invoice as any,salesContext,client)).rejects.toThrow(/bloqueada/);await pool.query(`UPDATE "CompanySettings" SET environment='BETA' WHERE id=1`);
  const authority=new NativeB2bBillingAuthority(client as any);expect(await authority.fromGrants([{scope:'production:guides:issue:09',binding:{ruc:s.issuer.ruc,branchId:s.scope.branchId,pointId:s.scope.pointId,series:'T992'}}])).toEqual([]);
  const response=await api('',request,uuid(700));expect(response.status).toBe(201);const r=await response.json();expect((await (await api('',request,uuid(700))).json()).deduplicated).toBe(true);
  const runtime=new ProductionGuidesBillingRuntime(client,owner,service,greEnabled);active=false;await expect(runtime.flush()).rejects.toThrow('revocado');expect(submit).not.toHaveBeenCalled();active=true;await runtime.flush();await service.process(r.documentId);expect(submit).toHaveBeenCalledTimes(1);
  service=new ProductionGuidesService(new ProductionGuidesStore(client,k.statusSigner,'LOCAL_SYNTHETIC'),options);
  expect(await owner.status(r.documentId,actor)).toMatchObject({state:'ACCEPTED',source:'LOCAL_SYNTHETIC',officialCdrVerified:false});
  const xml=await owner.artifact(r.documentId,'signed-xml',actor);expect(xml.bytes.toString()).toContain('10000000001');expect(xml.bytes.toString()).toContain('10000000002');expect((await owner.artifact(r.documentId,'cdr-zip',actor)).bytes.length).toBeGreaterThan(0);expect((await owner.pdf(r.documentId,actor)).subarray(0,5).toString()).toBe('%PDF-');
  expect((await api('/'+r.documentId+'/status')).status).toBe(200);const publicXml=await api('/'+r.documentId+'/artifacts/signed-xml');expect(publicXml.status).toBe(200);expect(await publicXml.text()).toBe(xml.bytes.toString());const publicPdf=await api('/'+r.documentId+'/pdf');expect(publicPdf.status).toBe(200);expect(Buffer.from(await publicPdf.arrayBuffer()).subarray(0,5).toString()).toBe('%PDF-');
  expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter" WHERE id=$1',[s.scope.seriesCounterId])).rows[0].nextNumber).toBe('2');
  failCdr=true;await expect(owner.pdf(r.documentId,actor)).rejects.toThrow();failCdr=false;
  const second=await owner.issue(request,uuid(710),actor);currentNumber='2';throwPost=true;await runtime.flush();expect((await service.process(second.documentId)).state).toBe('UNKNOWN');const posts=submit.mock.calls.length;
  service=new ProductionGuidesService(new ProductionGuidesStore(client,k.statusSigner,'LOCAL_SYNTHETIC'),options);await service.process(second.documentId);await service.tick();expect(submit).toHaveBeenCalledTimes(posts);
  const event=await owner.event(r.documentId,actor);active=false;await expect(owner.current(event)).rejects.toThrow('revocado');active=true;
  throwPost=false;tamperCdr=true;currentNumber='3';const third=await owner.issue(request,uuid(711),actor);await runtime.flush();await expect(service.process(third.documentId)).rejects.toThrow('GUIDE_CDR_SIGNATURE_UNTRUSTED');const beforeRecovery=submit.mock.calls.length;
  tamperCdr=false;expect((await service.process(third.documentId)).state).toBe('ACCEPTED');expect(submit).toHaveBeenCalledTimes(beforeRecovery);expect(oauthCount).toBeGreaterThan(0);
  await owner.configure(s.scope.seriesCounterId,{...grant,expectedVersion:2,enabled:false,profiles:[s.profile]},actor);await expect(owner.current(event)).rejects.toThrow(/Concesi/);
  const counterBeforeRevoked=(await pool.query('SELECT "nextNumber" FROM "SeriesCounter" WHERE id=$1',[counter.id])).rows[0].nextNumber,postsBeforeRevoked=submit.mock.calls.length;
  await expect(owner.issue(request,uuid(7999),actor)).rejects.toThrow(/Concesi/);expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter" WHERE id=$1',[counter.id])).rows[0].nextNumber).toBe(counterBeforeRevoked);expect(submit).toHaveBeenCalledTimes(postsBeforeRevoked);
  expect((await pool.query('SELECT environment FROM "CompanySettings" WHERE id=1')).rows[0].environment).toBe('BETA');
  expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter" WHERE id=$1',[betaGuideId])).rows[0].nextNumber).toBe('41');expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter" WHERE id=$1',[betaInvoiceId])).rows[0].nextNumber).toBe('9');expect((await pool.query('SELECT row_to_json(d) AS value FROM "Document" d WHERE id=$1',[uuid(662)])).rows[0].value).toEqual(historical);
  for(const flag of ['BILLING_PRODUCTION_ISSUANCE_ENABLED','BILLING_PRODUCTION_NOTES_ENABLED','SUNAT_PRODUCTION_WORKFLOW_ENABLED'])expect(process.env[flag]).toBe('false');
  }finally{await app?.close();restoreControllerGuards?.();vault.onModuleDestroy();vaultKey.fill(0);vi.unstubAllEnvs();transport.clear();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
 }),120000);
});
