/* Isolated additive DDL/CAS rehearsal. Never connects to an existing database. */
const {spawnSync}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
if(process.argv.slice(2).join(' ')!=='--isolated-synthetic-only')throw Error('Explicit isolated rehearsal flag required');
const context='desktop-linux',id=randomUUID(),name='factuez-dispatch-ddl-'+id,label='factuez.test.dispatch-ddl';
let created=false,checks=0;
function docker(args,input,allowFailure=false){
 const result=spawnSync('docker',['--context',context,...args],{input,encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:1024*1024});
 if(result.error||(!allowFailure&&result.status!==0))throw Error('Isolated Docker operation failed');
 return result;
}
function sql(text,allowFailure=false){return docker(['exec','-i',name,'psql','-U','synthetic','-d','synthetic','-X','-v','ON_ERROR_STOP=1','-At'],text,allowFailure);}
function equal(query,value){if(sql(query).stdout.trim()!==value)throw Error('Isolated SQL assertion failed');checks++;}
(async()=>{
 try{
  const endpoint=docker(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).stdout.trim();
  if(!endpoint.startsWith('npipe:')||!endpoint.toLowerCase().includes('dockerdesktoplinuxengine'))throw Error('Only local Docker Desktop engine allowed');
  const image=docker(['image','inspect','postgres:17-alpine','--format','{{.Id}}']).stdout.trim();
  if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Local image required');
  docker(['run','--pull','never','-d','--name',name,'--label',label+'='+id,'--network','none','--memory','256m','--cpus','1',
   '--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=192m','-e','POSTGRES_USER=synthetic','-e','POSTGRES_DB=synthetic','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);created=true;
  let ready=false;for(let i=0;i<60;i++){if(docker(['exec',name,'pg_isready','-U','synthetic','-d','synthetic'],undefined,true).status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,250));}
  if(!ready)throw Error('Ephemeral database not ready');
  sql(`CREATE TYPE "SunatEnvironment" AS ENUM ('BETA','PRODUCTION');`);
  sql(readFileSync(require('node:path').join(__dirname,'../services/sunat-service/prisma/production-dispatch.sql'),'utf8'));
  const row=(ruc,env='PRODUCTION',profile='01-PEN-0101-IGV18-v1')=>`INSERT INTO "FiscalDispatchAuthorization" ("issuerRuc","environment","profile","credentialRevision","certificateFingerprint","actorId","updatedAt") VALUES ('${ruc}','${env}','${profile}',1,'${'a'.repeat(64)}','11111111-1111-4111-8111-111111111111',CURRENT_TIMESTAMP);`;
  sql(row('00000000001'));sql(row('00000000002'));
  equal(`SELECT "enabled" FROM "FiscalDispatchAuthorization" WHERE "issuerRuc"='00000000001';`,'f');
  if(sql(`UPDATE "FiscalDispatchAuthorization" SET "enabled"=true WHERE "issuerRuc"='00000000001';`,true).status===0)throw Error('Missing attestation accepted');checks++;
  equal(`WITH changed AS (UPDATE "FiscalDispatchAuthorization" SET "enabled"=true,"registrationAttestedAt"=CURRENT_TIMESTAMP,"version"=2 WHERE "issuerRuc"='00000000001' AND "version"=1 RETURNING 1) SELECT count(*) FROM changed;`,'1');
  equal(`WITH changed AS (UPDATE "FiscalDispatchAuthorization" SET "enabled"=false WHERE "issuerRuc"='00000000001' AND "version"=1 RETURNING 1) SELECT count(*) FROM changed;`,'0');
  equal(`SELECT "enabled" FROM "FiscalDispatchAuthorization" WHERE "issuerRuc"='00000000002';`,'f');
  sql(`BEGIN; UPDATE "FiscalDispatchAuthorization" SET "enabled"=false WHERE "issuerRuc"='00000000001'; ROLLBACK;`);
  equal(`SELECT "enabled" FROM "FiscalDispatchAuthorization" WHERE "issuerRuc"='00000000001';`,'t');
  for(const text of [row('00000000001'),row('00000000003','BETA'),row('00000000003','PRODUCTION','unsupported')]){
   if(sql(text,true).status===0)throw Error('DDL boundary accepted invalid data');checks++;
  }
  console.log(JSON.stringify({result:'PASS',checks,database:'new ephemeral tmpfs',network:'none',publishedPorts:0,realData:false,officialRequests:0}));
 }finally{
  if(created){const actual=docker(['inspect',name,'--format','{{index .Config.Labels "'+label+'"}}']).stdout.trim();if(actual!==id)throw Error('Cleanup ownership mismatch');docker(['rm','-f',name]);}
 }
})().catch(()=>{console.error('Isolated production authorization rehearsal failed');process.exitCode=1;});
