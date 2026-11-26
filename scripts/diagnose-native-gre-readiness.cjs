'use strict';
// Phase 2, operator-invoked only. No issue/admit/ingest/OAuth or external calls.
// --metadata: SUNAT DB schema/SELECT privileges only; never selects credential rows.
// --readiness: same private read attempted by the authorized UI; may inspect stored
// credentials inside the existing service, but no secret/config/body is printed.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),tls=require('node:tls'),{createRequire}=require('node:module');
const safeCodes=new Set(['42P01','42703','42501','57014','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','ECONNRESET','EAI_AGAIN','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','SELF_SIGNED_CERT_IN_CHAIN','SERVER_PIN_MISMATCH','INTERNAL_ERROR','INVALID_REQUEST','ACCESS_DENIED','SERVICE_UNAVAILABLE','RESOURCE_NOT_FOUND','BODY_TOO_LARGE']);
function safeCode(e){const c=e?.code;return safeCodes.has(c)||typeof c==='string'&&/^P20[0-9]{2}$/.test(c)?c:'UNCLASSIFIED_FAILURE';}
function config(){const c=JSON.parse(fs.readFileSync(process.env.NATIVE_GRE_CONFIG_FILE,'utf8'));if(c.version!=='factuez.native-gre.host.v1'||!c.listener)throw Error();return c;}
async function readiness(companyId,issuerRuc){
 const c=config(),u=new URL(c.remote.origin);if(u.protocol!=='https:'||u.hostname!=='sunat-service'||u.port!=='3443'||u.pathname!=='/'||u.username||u.password||u.hash||u.search||!/^[a-f0-9]{64}$/.test(c.remote.serverFingerprint))throw Error();
 const material={ca:fs.readFileSync(c.listener.caFile),cert:fs.readFileSync(c.listener.certFile),key:fs.readFileSync(c.listener.keyFile)},start=Date.now();
 return new Promise(resolve=>{
  let done=false,timer;const finish=value=>{if(!done){done=true;clearTimeout(timer);material.key.fill(0);resolve({elapsedMs:Date.now()-start,ownerTimeoutMs:45000,...value});}};
  const input=Buffer.from(JSON.stringify({companyId,issuerRuc}));
  const q=https.request(new URL('/internal/production-guides/sunat/readiness',u),{method:'POST',...material,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(host,cert)=>tls.checkServerIdentity(host,cert)||(cert.fingerprint256?.replaceAll(':','').toLowerCase()!==c.remote.serverFingerprint?Object.assign(Error('SERVER_PIN_MISMATCH'),{code:'SERVER_PIN_MISMATCH'}):undefined),headers:{'Content-Type':'application/json','Content-Length':input.length}},s=>{
   const pinMatched=s.socket.authorized===true&&s.socket.getPeerCertificate().fingerprint256?.replaceAll(':','').toLowerCase()===c.remote.serverFingerprint;
   if(!pinMatched){s.destroy();finish({code:'SERVER_PIN_MISMATCH'});return;}
   let size=0;const parts=[];s.on('data',b=>{size+=b.length;if(size>1024*1024){finish({code:'READINESS_RESPONSE_LIMIT'});q.destroy();}else parts.push(b);});s.on('error',e=>finish({code:safeCode(e)}));s.on('end',()=>{
    let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{finish({code:'READINESS_INVALID_JSON',httpStatus:s.statusCode});return;}
    const known=[['Activación explícita','GRE_GATES_PENDING'],['Catálogo de bienes','CATALOGUE_PENDING'],['Migración GRE SUNAT','SUNAT_SCHEMA_PENDING'],['Credenciales GRE/SOL','CREDENTIALS_PENDING'],['Credenciales, certificado','CREDENTIALS_PKI_XSD_BLOCKED'],['Validador oficial','OFFICIAL_RULES_PENDING'],['Confianza de firmas CDR','CDR_TRUST_PENDING']];
    finish({code:'READINESS_HTTP_RESPONSE',pinMatched,httpStatus:s.statusCode,...(typeof body.code==='string'?{problemCode:safeCode({code:body.code})}:{}),...(typeof body.ready==='boolean'?{ready:body.ready}:{}),...(Number.isSafeInteger(body.credentialRevision)&&body.credentialRevision>=0?{credentialRevision:body.credentialRevision}:{}),...(Array.isArray(body.blockers)?{blockerCodes:body.blockers.map(v=>known.find(([p])=>typeof v==='string'&&v.startsWith(p))?.[1]??'OTHER_BLOCKER')}:{} )});
   });
  });q.on('error',e=>finish({code:safeCode(e)}));timer=setTimeout(()=>{finish({code:'READINESS_TIMEOUT_55S'});q.destroy();},55000);q.end(input);
 });
}
async function metadata(){
 // Fixed installed owner identity and transport; no caller-provided SQL/DSN/path.
 if(process.env.DB_NAME!=='factuez_sunat'||process.env.DB_USER!=='factuez_sunat'||(process.env.DB_HOST??'postgres')!=='postgres'||(process.env.DB_PORT??'5432')!=='5432'||!/^\/run\/secrets\/[a-zA-Z0-9_-]+$/.test(process.env.DB_PASSWORD_FILE??''))return {code:'SUNAT_OWNER_METADATA_CONTEXT_REQUIRED'};
 const local=createRequire(path.join(process.cwd(),'services/sunat-service/package.json')),{Pool}=local('pg'),pool=new Pool({host:'postgres',port:5432,database:'factuez_sunat',user:'factuez_sunat',password:fs.readFileSync(process.env.DB_PASSWORD_FILE,'utf8').trim(),max:1,connectionTimeoutMillis:3000,query_timeout:5000,statement_timeout:3000,application_name:'gre_readonly_schema_diagnostic'});pool.on('error',()=>{});let db;
 try{db=await pool.connect();await db.query('BEGIN READ ONLY');const identity=(await db.query("SELECT current_database()='factuez_sunat' AND current_user='factuez_sunat' AS expected, current_schema()='public' AS public_schema")).rows[0];if(!identity.expected)return {code:'SUNAT_OWNER_METADATA_CONTEXT_REQUIRED'};
  const tables={ProductionGuidesCatalogue:['issuerRuc','revision','companyId','payload'],ProductionGuidesJob:['documentId','state','revision'],SunatCredentials:['issuerRuc','environment','revision']},checks=[];
  for(const [table,columns]of Object.entries(tables)){
   const rel='"'+table+'"',row=(await db.query('SELECT to_regclass($1) IS NOT NULL AS present, CASE WHEN to_regclass($1) IS NOT NULL THEN has_table_privilege(current_user,to_regclass($1),\'SELECT\') ELSE false END AS selectable',[rel])).rows[0];
   const actual=(await db.query('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=ANY($2::text[])',[table,columns])).rows.map(r=>r.column_name);checks.push({table,present:row.present,selectable:row.selectable,missingColumns:columns.filter(c=>!actual.includes(c))});
  }
  return {code:'SUNAT_SCHEMA_METADATA',ownerMatches:true,publicSchema:identity.public_schema,tables:checks};
 }catch(e){return {code:safeCode(e)};}finally{try{await db?.query('ROLLBACK');}catch{}db?.release();await pool.end();}
}
async function main(){
 const args=process.argv.slice(2);let result;
 if(args.length===1&&args[0]==='--metadata')result=await metadata();
 else if(args.length===5&&args[0]==='--readiness'&&args[1]==='--company-id'&&/^[1-9][0-9]{0,9}$/.test(args[2])&&Number.isSafeInteger(Number(args[2]))&&args[3]==='--issuer-ruc'&&/^[0-9]{11}$/.test(args[4]))result=await readiness(Number(args[2]),args[4]);
 else result={code:'INVALID_DIAGNOSTIC_MODE'};
 console.log(JSON.stringify({version:2,...result}));
}
if(require.main===module||(module.id==='[stdin]'&&process.argv[1]==='-'))main().catch(()=>{console.log(JSON.stringify({version:2,code:'READINESS_DIAGNOSTIC_BLOCKED'}));process.exitCode=1;});
module.exports={readiness,metadata};
