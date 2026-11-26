'use strict';
// Read-only transport diagnostic: only the configured GRE transport PKI is read.
// Deliberately invalid bodies stop before readiness, catalogue or Identity DB/vault readers.
// No fiscal keys, vault, P12, credentials, environment inventory or external services.
const fs=require('node:fs'),https=require('node:https'),{X509Certificate}=require('node:crypto');
const allowedErrors=new Set(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNRESET','EHOSTUNREACH','ENETUNREACH','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED','ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE']);
async function probe(c,remote,route,body){
 let tls;try{tls={ca:fs.readFileSync(c.listener.caFile),cert:fs.readFileSync(c.listener.certFile),key:fs.readFileSync(c.listener.keyFile)};}catch{return {code:'TRANSPORT_FILE_UNREADABLE'};}
 let u;try{u=new URL(remote.origin);if(u.protocol!=='https:'||!['identity-service','billing-service','sunat-service'].includes(u.hostname)||!['3441','3442','3443'].includes(u.port)||u.pathname!=='/'||u.search||u.hash||u.username||u.password||!/^[a-f0-9]{64}$/.test(remote.serverFingerprint))throw Error();}catch{return {code:'TRANSPORT_TARGET_INVALID'};}
 return new Promise(resolve=>{
  let done=false;const finish=value=>{if(!done){done=true;tls.key.fill(0);resolve(value);}};
  const input=Buffer.from(JSON.stringify(body));
  const q=https.request(new URL(route,u),{method:'POST',...tls,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{'Content-Type':'application/json','Content-Length':input.length}},s=>{
   const peer=s.socket.getPeerCertificate(),tlsAuthorized=s.socket.authorized===true,pinMatched=tlsAuthorized&&peer.fingerprint256?.replaceAll(':','').toLowerCase()===remote.serverFingerprint;
   s.resume();s.on('end',()=>finish({code:pinMatched?'HTTP_RESPONSE':'SERVER_PIN_MISMATCH',tlsAuthorized,pinMatched,status:s.statusCode}));
  });q.on('error',e=>finish({code:allowedErrors.has(e.code)?e.code:'TRANSPORT_FAILED'}));q.setTimeout(6000,()=>{finish({code:'ETIMEDOUT'});q.destroy();});q.end(input);
 });
}
async function main(){
 let c;try{c=JSON.parse(fs.readFileSync(process.env.NATIVE_GRE_CONFIG_FILE,'utf8'));if(c.version!=='factuez.native-gre.host.v1'||!c.listener||!Array.isArray(c.peers))throw Error();}catch{console.log(JSON.stringify({code:'GRE_CONFIG_UNREADABLE'}));return;}
 let cert;try{const x=new X509Certificate(fs.readFileSync(c.listener.certFile));cert={validNow:Date.parse(x.validFrom)<=Date.now()&&Date.now()<Date.parse(x.validTo),validTo:new Date(x.validTo).toISOString()};}catch{cert={code:'TRANSPORT_CERT_UNREADABLE'};}
 const result={version:1,nativeEnabled:process.env.NATIVE_GRE_ENABLED==='true',workersEnabled:process.env.NATIVE_GRE_WORKERS_ENABLED==='true',peerCount:c.peers.length,transportCertificate:cert};
 if(c.remote){const host=new URL(c.remote.origin).hostname;result.remote=await probe(c,c.remote,host==='sunat-service'?'/internal/production-guides/sunat/readiness':'/internal/production-guides/billing/catalogue-source',{companyId:1,issuerRuc:'INVALID_SYNTHETIC_PROBE'});}
 if(c.identity)result.identity=await probe(c,c.identity,'/internal/production-guides/identity/current',{userId:'INVALID_SYNTHETIC_PROBE'});
 console.log(JSON.stringify(result));
}
if(require.main===module||(module.id==='[stdin]'&&process.argv[1]==='-'))main().catch(()=>{console.log(JSON.stringify({code:'GRE_DIAGNOSTIC_BLOCKED'}));process.exitCode=1;});
module.exports={probe};
