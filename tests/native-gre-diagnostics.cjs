'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..'),env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},checks=[];
function child(args,input){const r=spawnSync(process.execPath,args,{cwd:root,env,input,encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(r.status,0);assert.equal(r.stderr,'');return r.stdout.trim().split(/\r?\n/).filter(Boolean);}
for(const name of ['diagnose-native-gre-private.cjs','diagnose-native-gre-readiness.cjs']){
 const file=path.join(root,'scripts',name),expected=name.includes('readiness')?'INVALID_DIAGNOSTIC_MODE':'GRE_CONFIG_UNREADABLE';
 for(const [label,args,input]of [['file',[file],undefined],['stdin',['-'],fs.readFileSync(file,'utf8')]]){const rows=child(args,input);assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0]).code,expected);checks.push(name+'-'+label+'-one-json');}
 const imported=child(['-e',`const fs=require('node:fs'),https=require('node:https');let reads=0,calls=0;const read=fs.readFileSync;process.env.NATIVE_GRE_CONFIG_FILE='SYNTHETIC_FORBIDDEN_READ';fs.readFileSync=function(p,...a){if(p==='SYNTHETIC_FORBIDDEN_READ'){reads++;throw Error('UNEXPECTED_IO');}return read.call(this,p,...a);};https.request=()=>{calls++;throw Error('UNEXPECTED_IO');};require(${JSON.stringify(file)});setImmediate(()=>console.log(JSON.stringify({reads,calls})));`]);assert.deepEqual(imported,['{"reads":0,"calls":0}']);checks.push(name+'-import-no-config-or-network-io');
}
assert.deepEqual(JSON.parse(child([path.join(root,'scripts/diagnose-native-gre-readiness.cjs'),'--metadata'])[0]),{version:2,code:'SUNAT_OWNER_METADATA_CONTEXT_REQUIRED'});checks.push('metadata-refuses-unknown-database-before-files-or-network');
// Deterministic stream lifecycle regression: Node can detach response.socket at end.
// Do not establish a real connection here; real mTLS is covered by bootstrap e2e.
(async()=>{
 const {probe}=require('../scripts/diagnose-native-gre-private.cjs');
 const https=require('node:https'),read=fs.readFileSync,request=https.request,pin='a'.repeat(64),req=new EventEmitter();req.end=()=>{};req.setTimeout=()=>{};req.destroy=()=>{};
 try{fs.readFileSync=()=>Buffer.from('SYNTHETIC TRANSPORT ONLY');https.request=(_u,_o,callback)=>{const response=new EventEmitter();response.statusCode=400;response.socket={authorized:true,getPeerCertificate:()=>({fingerprint256:pin})};response.resume=()=>{};setImmediate(()=>{callback(response);response.socket=null;response.emit('end');});return req;};const answer=await probe({listener:{caFile:'synthetic-ca',certFile:'synthetic-cert',keyFile:'synthetic-key'}},{origin:'https://sunat-service:3443',serverFingerprint:pin},'/internal/production-guides/sunat/readiness',{companyId:1,issuerRuc:'INVALID_SYNTHETIC_PROBE'});assert.deepEqual(answer,{code:'HTTP_RESPONSE',tlsAuthorized:true,pinMatched:true,status:400});checks.push('tls-authorization-snapshot-survives-detached-socket');}
 finally{fs.readFileSync=read;https.request=request;}
 const result={synthetic:true,checks,failures:[]};fs.mkdirSync(path.join(root,'output/gre-runtime-repair-20261126'),{recursive:true});fs.writeFileSync(path.join(root,'output/gre-runtime-repair-20261126/diagnostic-tests.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(()=>{console.error('SYNTHETIC_DIAGNOSTIC_TEST_FAILED');process.exitCode=1;});
