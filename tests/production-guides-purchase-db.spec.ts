import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:https';
import {createHash} from 'node:crypto';
import {purchaseSnapshot,purchaseCatalogue} from './production-guides-purchase.fixture';
import {seals,uuid,now,tlsFixture} from './production-guides.fixture';
import {ProductionGuidesRest,ProductionGuidesHttps} from '../services/sunat-service/src/production-guides-transport';
import {productionTransportXml} from '../services/sunat-service/src/infrastructure/sunat/production-transport-zip';
import {buildProductionGuidesXml,productionGuidesHash as hash,PRODUCTION_GUIDES_XSD_SHA256} from '../packages/sunat-core/src/production-guides';
import {ProductionGuidesOwner} from '../services/billing-service/src/production-guides-owner';
import {ProductionGuidesBillingRuntime} from '../services/billing-service/src/production-guides-runtime';
import {ProductionGuidesStore} from '../services/sunat-service/src/production-guides-store';
import {ProductionGuidesService} from '../services/sunat-service/src/production-guides-service';
import {ProductionGuidesCatalogueRules} from '../services/sunat-service/src/production-guides-crypto';
import {validateOfficialGreXml} from '../services/sunat-service/src/production-guides-official-rules';
import {signLocalGuideXml} from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import {createGuideSidecarPki,guideSidecarCdrXml,guideSidecarPackCdr} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {renderProductionGuidesPdf} from '../services/sunat-service/src/production-guides-pdf';
const local=createRequire(import.meta.url),{withCorrectionDatabase}=local('./helpers/correction-reservation-db.cjs');
describe('multi-family purchase GRE on real isolated Docker PostgreSQL',()=>{
 it('rejects fuel data before numbers/outbox, scopes new grants and persists signed XML/CDR/PDF through restart',async()=>withCorrectionDatabase(async({pool,client}:any)=>{
  for(const f of ['services/billing-service/prisma/production-guides.sql','services/sunat-service/prisma/production-guides.sql','services/billing-service/prisma/updates/20261124_gre_hydrocarbon_v1.sql'])await pool.query(readFileSync(resolve(f),'utf8'));
  const s=purchaseSnapshot(),b=s.body as any,c=purchaseCatalogue(s),k=seals(),pki=createGuideSidecarPki(s.issuer.ruc),actor={userId:s.actorId,scope:{kind:'GLOBAL' as const}};
  await pool.query(`INSERT INTO "CompanySettings" (id,ruc,"legalName","companyType","economicActivities","taxAddress",ubigeo,"contactEmails",environment,"updatedAt") VALUES (1,$1,$2,'SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],'PRODUCTION',now())`,[s.issuer.ruc,s.issuer.legalName]);
  await pool.query(`INSERT INTO "Branch" (id,"companyId",code,name,"establishmentCode") VALUES ($1,1,'SYNTHETIC','SYNTHETIC','0001')`,[s.scope.branchId]);
  await pool.query(`INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,1,$2,'SYNTHETIC','SYNTHETIC',now())`,[s.scope.pointId,s.scope.branchId]);
  await pool.query(`INSERT INTO "SeriesCounter" (id,"companyId","emissionPointId","documentType",series,environment,"updatedAt") VALUES ($1,1,$2,'DESPATCH_ADVICE','T991','PRODUCTION',now())`,[s.scope.seriesCounterId,s.scope.pointId]);
  await pool.query(`INSERT INTO "ProductUnit" (code,description) VALUES ('GLL','SYNTHETIC')`);
  for(const [i,item]of b.items.entries())await pool.query(`INSERT INTO "FuelProduct" (id,sku,description,category,"unitCode","taxAffectationCode","greGoodsFamily","updatedAt") VALUES ($1,$2,$3,'SYNTHETIC',$4,'10',$5,now())`,[uuid(701+i),item.code,item.description,item.unitCode,b.hydrocarbon.items[i].family]);
  const pins={credentialRevision:1,certificateFingerprint:pki.issuer.fingerprint,rulesSha256:hash(c),xsdSha256:PRODUCTION_GUIDES_XSD_SHA256};
  const signed=(snapshot:any,xml:string)=>{const r=signLocalGuideXml({issuerRuc:snapshot.issuer.ruc,documentType:'09',fullNumber:`${snapshot.series}-${snapshot.number}`,unsignedXml:xml},pki.issuer.pkcs12,pki.password);return {xml:Buffer.from(r.xml),zip:r.zip,xmlSha256:r.xmlSha256,zipSha256:r.zipSha256,fingerprint:r.certificateFingerprintSha256,digest:r.digestValue};};
  let service:ProductionGuidesService,active=true,throwPost=false,failCdr=false,crlExpired=false,tamperCdr=false;let currentNumber='1',oauthCount=0;
  const owner=new ProductionGuidesOwner(client,{enabled:()=>true,signer:k.ownerSigner,ownerVerifier:k.verifier,statusVerifier:k.verifier,actorCurrent:async()=>({scope:actor.scope,active,canIssue:true}),sunat:{grantEvidence:async()=>pins,admit:(s,g)=>service.admit(s,g),status:e=>service.status(e),artifact:(e,a)=>service.artifact(e,a),pdf:e=>service.pdf(e)},now:()=>now});
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
    const expected={issuerRuc:s.issuer.ruc,documentType:'09' as const,fullNumber:'T991-'+currentNumber,requestXmlSha256:'a'.repeat(64),requestZipSha256:'b'.repeat(64),issuedAt:b.issueDate,receivedAt:now};
    let signed=pki.signCdr(guideSidecarCdrXml(expected).replace('FICTITIOUS LOCAL RECEIPT','<![CDATA[SYNTHETIC PURCHASE RECEIPT]]>'));
    if(tamperCdr)signed=signed.replace('SYNTHETIC PURCHASE RECEIPT','SYNTHETIC ALTERED RECEIPT');
    res.end(JSON.stringify({codRespuesta:'0',indCdrGenerado:'1',arcCdr:guideSidecarPackCdr(signed,expected).toString('base64')}));
   }catch{res.destroy();}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`https://127.0.0.1:${(server.address() as any).port}`;
  const transport=new ProductionGuidesRest({http:new ProductionGuidesHttps({origin,ca:tls.ca}),syntheticOrigin:origin,authorize:async(_action,g)=>{await owner.currentGrant(g);},credentials:{withGre:async(_g,work)=>work({clientId:'SYNTHETIC',clientSecret:'SYNTHETIC_GRE'},{username:'SECONDARY',password:'SYNTHETIC_SOL'})}});
  let app:any,restoreControllerGuards:(()=>void)|undefined;
  try{
  const options={enabled:()=>true,owner:{current:(e:any)=>owner.current(e),reference09:async()=>{throw Error('UNUSED');}},referenceOwner:(s:any)=>owner.referenceOwner(s),ownerVerifier:k.verifier,crypto:{ready:async(snapshot:any,g:any)=>{if(crlExpired)throw Error('SYNTHETIC_EXPIRED_CRL');await new ProductionGuidesCatalogueRules(c).validate(snapshot,g);const signedXml=signed(snapshot,buildProductionGuidesXml(snapshot).xml).xml.toString();await validateOfficialGreXml(signedXml,`${s.issuer.ruc}-09-T991-${snapshot.number}.xml`);},sign:async(snapshot:any,_g:any,xml:string)=>signed(snapshot,xml)},transport,cdr:{verify:(bytes:Buffer)=>failCdr?Promise.resolve(false):pki.cdrVerifier.verify(bytes)},pdf:renderProductionGuidesPdf,now:()=>now};
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
  const grant={expectedVersion:0,actorId:actor.userId,enabled:true,profiles:['GRE09_PRIVATE04_V1'],expectedCredentialRevision:1,expiresAt:'2026-12-31T00:00:00Z'};
  await owner.configure(s.scope.seriesCounterId,grant,actor);
  const request={seriesCounterId:s.scope.seriesCounterId,profile:s.profile,body:b};
  await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow('Concesión');
  expect((await api('/series/'+s.scope.seriesCounterId+'/grants',{...grant,expectedVersion:1,profiles:[s.profile]})).status).toBe(201);
  for(const family of ['UNCLASSIFIED','NON_REGULATED']){
   await pool.query('UPDATE "FuelProduct" SET "greGoodsFamily"=$1 WHERE sku=\'PURCHASE-1\'',[family]);
   await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow('clasificación');
  }
  await pool.query('UPDATE "FuelProduct" SET "greGoodsFamily"=\'DIESEL\' WHERE sku=\'PURCHASE-1\'');
  for(const bad of [{...b,hydrocarbon:{...b.hydrocarbon,items:[{...b.hydrocarbon.items[0],scopCode:'INVALID'},...b.hydrocarbon.items.slice(1)]}},{...b,hydrocarbon:{...b.hydrocarbon,senderRegistration:'OTHER-RH'}},{...b,items:[{...b.items[0],unitCode:'LTR'}]}])await expect(owner.issue({...request,body:bad},uuid(700),actor)).rejects.toThrow();
  await expect(owner.issue(request,uuid(700),{...actor,scope:{kind:'ASSIGNED',branchIds:[],emissionPointIds:[],series:[]}})).rejects.toThrow();
  expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter"')).rows[0].nextNumber).toBe('1');expect((await pool.query('SELECT count(*)::int n FROM "OutboxEvent"')).rows[0].n).toBe(0);
  crlExpired=true;await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow('EXPIRED_CRL');crlExpired=false;
  const removed=c.hydrocarbonApprovals!.pop()!;await expect(owner.issue(request,uuid(700),actor)).rejects.toThrow();c.hydrocarbonApprovals!.push(removed);
  const wrongSupplier={...b,supplier:s.issuer};await expect(owner.issue({...request,body:wrongSupplier},uuid(700),actor)).rejects.toThrow();
  const response=await api('',request,uuid(700));expect(response.status).toBe(201);const r=await response.json();expect((await (await api('',request,uuid(700))).json()).deduplicated).toBe(true);
  const runtime=new ProductionGuidesBillingRuntime(client,owner,service,()=>true);active=false;await expect(runtime.flush()).rejects.toThrow('revocado');expect(submit).not.toHaveBeenCalled();active=true;await runtime.flush();await service.process(r.documentId);expect(submit).toHaveBeenCalledTimes(1);
  service=new ProductionGuidesService(new ProductionGuidesStore(client,k.statusSigner,'LOCAL_SYNTHETIC'),options);
  expect(await owner.status(r.documentId,actor)).toMatchObject({state:'ACCEPTED',source:'LOCAL_SYNTHETIC',officialCdrVerified:false});
  const xml=await owner.artifact(r.documentId,'signed-xml',actor);expect(xml.bytes.toString()).toContain('10000000001');expect(xml.bytes.toString()).toContain('10000000002');expect((await owner.artifact(r.documentId,'cdr-zip',actor)).bytes.length).toBeGreaterThan(0);expect((await owner.pdf(r.documentId,actor)).subarray(0,5).toString()).toBe('%PDF-');
  expect((await api('/'+r.documentId+'/status')).status).toBe(200);const publicXml=await api('/'+r.documentId+'/artifacts/signed-xml');expect(publicXml.status).toBe(200);expect(await publicXml.text()).toBe(xml.bytes.toString());const publicPdf=await api('/'+r.documentId+'/pdf');expect(publicPdf.status).toBe(200);expect(Buffer.from(await publicPdf.arrayBuffer()).subarray(0,5).toString()).toBe('%PDF-');
  expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter"')).rows[0].nextNumber).toBe('2');
  failCdr=true;await expect(owner.pdf(r.documentId,actor)).rejects.toThrow();failCdr=false;
  const second=await owner.issue(request,uuid(710),actor);currentNumber='2';throwPost=true;await runtime.flush();expect((await service.process(second.documentId)).state).toBe('UNKNOWN');const posts=submit.mock.calls.length;
  service=new ProductionGuidesService(new ProductionGuidesStore(client,k.statusSigner,'LOCAL_SYNTHETIC'),options);await service.process(second.documentId);await service.tick();expect(submit).toHaveBeenCalledTimes(posts);
  const event=await owner.event(r.documentId,actor);active=false;await expect(owner.current(event)).rejects.toThrow('revocado');active=true;
  throwPost=false;tamperCdr=true;currentNumber='3';const third=await owner.issue(request,uuid(711),actor);await runtime.flush();await expect(service.process(third.documentId)).rejects.toThrow('GUIDE_CDR_SIGNATURE_UNTRUSTED');const beforeRecovery=submit.mock.calls.length;
  tamperCdr=false;expect((await service.process(third.documentId)).state).toBe('ACCEPTED');expect(submit).toHaveBeenCalledTimes(beforeRecovery);expect(oauthCount).toBeGreaterThan(0);
  await owner.configure(s.scope.seriesCounterId,{...grant,expectedVersion:2,enabled:false,profiles:[s.profile]},actor);await expect(owner.current(event)).rejects.toThrow(/Concesi/);
  }finally{await app?.close();restoreControllerGuards?.();transport.clear();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
 }),120000);
});
