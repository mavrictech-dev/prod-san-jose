import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {X509Certificate,generateKeyPairSync,createSign} from 'node:crypto';
import {snapshot09,seals,tlsFixture,uuid} from './production-guides.fixture';
import {ProductionGuidesPrivateHttp} from '../packages/sunat-core/src/production-guides-private';
import {startNativeGreListener,NativeGreListenerLifecycle} from '../packages/service-access/src/native-gre-host';
const local=createRequire(import.meta.url),{withCorrectionDatabase}=local('./helpers/correction-reservation-db.cjs');
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
describe('native GRE modules and real private listener HTTP composition, isolated PostgreSQL',()=>{
 it('mounts capabilities/list/issue, protects private adapters by mTLS, and rechecks live Identity without official calls',async()=>withCorrectionDatabase(async({client,pool,local:requireBilling}:any)=>{
  const root=resolve('.'),sunatRequire=createRequire(join(root,'services/sunat-service/package.json')),identityRequire=createRequire(join(root,'services/identity-service/package.json'));
  const {ProductionGuidesBillingModule}=requireBilling('./dist/production-guides.module'),{ProductionGuidesOwner}=requireBilling('./dist/production-guides-owner'),{JwtPermissionGuard}=requireBilling('./dist/auth/jwt-permission.guard');
  const {ProductionGuidesSunatModule}=sunatRequire('./dist/production-guides.module'),{ProductionGuidesIdentityController}=identityRequire('./dist/production-guides-identity.controller'),{PrismaService:IdentityDb}=identityRequire('./dist/infrastructure/prisma.service'),{UserPermissionsService}=identityRequire('./dist/application/user-permissions.service');
  const {NestFactory,Reflector}=requireBilling('@nestjs/core'),{Module,UnauthorizedException,ForbiddenException}=requireBilling('@nestjs/common');
  for(const side of ['billing','sunat'])await pool.query(readFileSync(join(root,'services',side+'-service/prisma/production-guides.sql'),'utf8'));
  await pool.query('CREATE TABLE "SunatCredentials" ("issuerRuc" char(11),"environment" text,"revision" integer)');
  const seed=snapshot09();await pool.query(`INSERT INTO "CompanySettings" (id,ruc,"legalName","companyType","economicActivities","taxAddress",ubigeo,"contactEmails",environment,"updatedAt") VALUES (1,$1,$2,'SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],'PRODUCTION',now())`,[seed.issuer.ruc,seed.issuer.legalName]);
  await pool.query('INSERT INTO "Branch" (id,"companyId",code,name,"establishmentCode") VALUES ($1,1,\'SYNTHETIC\',\'SYNTHETIC\',\'0001\')',[seed.scope.branchId]);await pool.query('INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,1,$2,\'SYNTHETIC\',\'SYNTHETIC\',now())',[seed.scope.pointId,seed.scope.branchId]);
  const tls=tlsFixture(),pin=new X509Certificate(tls.cert).fingerprint256.replaceAll(':','').toLowerCase(),tlsOptions={...tls,serverFingerprint:pin},keys=seals(),privatePort=await port(),origin=`https://127.0.0.1:${privatePort}`,dir=mkdtempSync(join(tmpdir(),'factuez-synthetic-gre-http-'));
  for(const [name,bytes] of [['ca.pem',tls.ca],['cert.pem',tls.cert],['key.pem',tls.key]] as const)writeFileSync(join(dir,name),bytes);
  const config={version:'factuez.native-gre.host.v1' as const,listener:{host:'127.0.0.1',port:privatePort,caFile:join(dir,'ca.pem'),certFile:join(dir,'cert.pem'),keyFile:join(dir,'key.pem')},peers:[pin]};writeFileSync(join(dir,'config.json'),JSON.stringify(config));vi.stubEnv('NATIVE_GRE_CONFIG_FILE',join(dir,'config.json'));
  // A distinct database belongs to the same disposable container, never to the installed Identity.
  await pool.query('CREATE DATABASE gre_identity_synthetic');
  const {Pool}=requireBilling('pg'),identityPool=new Pool({...pool.options,database:'gre_identity_synthetic'});
  let identityClosing=false;identityPool.on('error',(error:any)=>{if(!identityClosing||error?.code!=='ERR_STREAM_DESTROYED')throw error;});
  const identityRoot=join(root,'services/identity-service');
  const ddl=spawnSync(process.execPath,[join(identityRoot,'node_modules/prisma/build/index.js'),'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],{cwd:identityRoot,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,DATABASE_URL:'postgresql://build:build@127.0.0.1:1/not_connected'}});
  expect(ddl.status,'ISOLATED_IDENTITY_SCHEMA_GENERATION_FAILED').toBe(0);await identityPool.query(ddl.stdout);
  const {PrismaPg}=identityRequire('@prisma/adapter-pg'),{PrismaClient}=identityRequire('./dist/generated/prisma/client');
  const identityDb=new PrismaClient({adapter:new PrismaPg(identityPool)}),extraPermissions=new UserPermissionsService(identityDb);
  await identityDb.user.create({data:{id:seed.actorId,username:'SYNTHETIC_GRE_ACTOR',fullName:'SYNTHETIC ONLY',passwordHash:'SYNTHETIC_NOT_A_PASSWORD'}});
  const role=await identityDb.role.create({data:{code:'ADMIN',name:'SYNTHETIC ADMIN'}}),permission=await identityDb.permission.create({data:{code:'DOCUMENT_ISSUE',name:'SYNTHETIC ISSUE'}});
  await identityDb.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});await identityDb.userRoleAssignment.create({data:{roleId:role.id,userId:seed.actorId}});
  let active=true;
  const identityHttp=new ProductionGuidesPrivateHttp(origin,tlsOptions),jwtKeys=generateKeyPairSync('rsa',{modulusLength:2048});writeFileSync(join(dir,'jwt-public.pem'),jwtKeys.publicKey.export({format:'pem',type:'spki'}));vi.stubEnv('JWT_PUBLIC_KEY_FILE',join(dir,'jwt-public.pem'));
  const token=(kind:string)=>{const now=Math.floor(Date.now()/1000),claims={sub:seed.actorId,username:'SYNTHETIC',fullName:'SYNTHETIC',roles:['ADMIN'],permissions:kind==='denied'?[]:['document.view','document.issue','sunat.configure'],scope:kind==='other-scope'?{kind:'ASSIGNED',branchIds:[],emissionPointIds:[],series:[]}:{kind:'GLOBAL'},authVersion:1,iat:now,exp:now+300,iss:'factuez-identity',aud:'factuez-services'};const bytes=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');return bytes+'.'+createSign('RSA-SHA256').update(bytes).sign(jwtKeys.privateKey).toString('base64url');};
  const billing=ProductionGuidesBillingModule.native({database:client,enabled:()=>false,runWorkers:false,ownerSigning:{keyId:'billing',key:keys.owner.privateKey},ownerPublicKeys:keys.keys,sunatPublicKeys:keys.keys,sunat:{origin,tls:tlsOptions,allowedPeerFingerprints:[pin]},identity:{current:(userId:string)=>identityHttp.post('/internal/production-guides/identity/current',{userId})}});

  const sunat=ProductionGuidesSunatModule.native({database:client,enabled:()=>false,runWorkers:false,vaultKey:Buffer.alloc(32,3),statusSigning:{keyId:'sunat',key:keys.sunat.privateKey},ownerPublicKeys:keys.keys,billing:{origin,tls:tlsOptions,allowedPeerFingerprints:[pin]},catalogues:[]});
  class TestHost{}Module({imports:[billing,sunat],controllers:[ProductionGuidesIdentityController],providers:[{provide:IdentityDb,useValue:identityDb},{provide:UserPermissionsService,useValue:extraPermissions},{provide:'NATIVE_GRE_LISTENER',useValue:new NativeGreListenerLifecycle()}]})(TestHost);
  let app:any;try{
   app=await NestFactory.create(TestHost,{logger:false});app.getHttpAdapter().getInstance().get('/api/v1/auth/me',(_q:any,res:any)=>{res.status(active?200:403).json({active});});await app.init();await startNativeGreListener(app,config);await app.listen(0,'127.0.0.1');const publicOrigin=await app.getUrl();vi.stubEnv('IDENTITY_INTERNAL_URL',publicOrigin);
   const tokenFor=token;
   const get=(path:string,token?:string)=>fetch(publicOrigin+path,{headers:token?{Authorization:'Bearer '+tokenFor(token)}:{}});
   expect((await get('/api/v1/production-guides/capabilities?pointId='+seed.scope.pointId)).status).toBe(401);expect((await get('/api/v1/production-guides/capabilities?pointId='+seed.scope.pointId,'denied')).status).toBe(403);expect((await get('/api/v1/production-guides/capabilities?pointId='+seed.scope.pointId,'other-scope')).status).toBe(403);
   const response=await get('/api/v1/production-guides/capabilities?pointId='+seed.scope.pointId,'reader');expect(response.status).toBe(200);const capability=await response.json();expect(capability).toMatchObject({implemented:true,installed:true,enabled:false,ready:false});expect(capability.blockers.join(' ')).toContain('Credenciales');expect(JSON.stringify(capability)).not.toMatch(/Cipher|PRIVATE KEY|clientSecret|password/);
   expect((await get('/api/v1/production-guides?pointId='+seed.scope.pointId,'reader')).status).toBe(200);
   expect((await fetch(publicOrigin+'/internal/production-guides/identity/current',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:seed.actorId})})).status).toBe(403);
   expect(await identityHttp.post('/internal/production-guides/identity/current',{userId:seed.actorId})).toMatchObject({active:true,authVersion:1,permissions:['document.issue'],scope:{kind:'GLOBAL'}});
   await identityDb.rolePermission.deleteMany();expect(await identityHttp.post('/internal/production-guides/identity/current',{userId:seed.actorId})).toMatchObject({permissions:[]});
   await identityDb.user.update({where:{id:seed.actorId},data:{active:false,authVersion:{increment:1}}});active=false;expect(await identityHttp.post('/internal/production-guides/identity/current',{userId:seed.actorId})).toMatchObject({active:false});
   active=true;const issued=await fetch(publicOrigin+'/api/v1/production-guides',{method:'POST',headers:{Authorization:'Bearer '+token('reader'),'Content-Type':'application/json','Idempotency-Key':uuid(900)},body:JSON.stringify({seriesCounterId:seed.scope.seriesCounterId,profile:seed.profile,body:seed.body})});expect(issued.status).toBe(503);expect((await pool.query('SELECT count(*)::int AS n FROM "ProductionGuidesReservation"')).rows[0].n).toBe(0);
  }finally{identityClosing=true;identityHttp.close();await app?.close();await identityDb.$disconnect();if(!identityPool.ended)await identityPool.end();vi.unstubAllEnvs();rmSync(dir,{recursive:true});}
 }),120000);
});
