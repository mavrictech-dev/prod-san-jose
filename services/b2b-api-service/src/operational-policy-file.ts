import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,join,normalize} from 'node:path';
import {inspect} from 'node:util';
import type {B2bOperationalPolicy,B2bOperationalPolicyPort} from './operational-control';

/** Concrete local operator policy. Reads one fixed metadata filename only;
 * never reads env, certificates, credentials, arbitrary caller paths or URLs.
 * Provision/ACL/atomic replacement belong to the authorized deployment. */
export class FileB2bOperationalPolicy implements B2bOperationalPolicyPort{
 #root:string;
 constructor(root:string){
  if(typeof root!=='string'||!isAbsolute(root)||root.length>1024||/[\x00-\x1f]/.test(root))throw new Error('B2B_OPERATIONAL_POLICY_DIRECTORY_REQUIRED');
  this.#root=normalize(root);
 }
 async current():Promise<B2bOperationalPolicy>{
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
   const root=await lstat(this.#root),resolved=await realpath(this.#root);
   const same=(a:string,b:string)=>process.platform==='win32'?normalize(a).toLowerCase()===normalize(b).toLowerCase():normalize(a)===normalize(b);
   if(!root.isDirectory()||root.isSymbolicLink()||!same(resolved,this.#root))throw 0;
   const path=join(this.#root,'b2b-operations.json'),before=await lstat(path);
   if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>1024||!same(await realpath(path),path))throw 0;
   file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const opened=await file.stat();
   if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)throw 0;
   const buffer=Buffer.alloc(1025),read=await file.read(buffer,0,buffer.length,0),after=await file.stat(),named=await lstat(path);
   if(read.bytesRead!==opened.size||read.bytesRead>1024||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||named.isSymbolicLink()||named.ino!==opened.ino||named.dev!==opened.dev||named.size!==opened.size||named.mtimeMs!==opened.mtimeMs)throw 0;
   const text=buffer.subarray(0,read.bytesRead).toString('utf8');
   // This flat ASCII control format needs no escaped keys/values. Reject
   // duplicate or escaped keys instead of accepting JSON's last-key-wins rule.
   if(text.includes('\\')||['environment','revision','mode'].some(k=>(text.match(new RegExp('"'+k+'"\\s*:','g'))??[]).length!==1))throw 0;
   const value=JSON.parse(text);
   if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='environment,mode,revision'||value.environment!=='BETA'||!Number.isSafeInteger(value.revision)||value.revision<1||value.revision>2147483647||!['OPEN','PAUSED'].includes(value.mode))throw 0;
   // Fresh local read grants a short admission lease, never a credential lease
   // or permission. The HTTP controller still authenticates and authorizes.
   return {...value,expiresAt:new Date(Date.now()+5000).toISOString()};
  }catch{throw new Error('B2B_OPERATIONAL_POLICY_UNAVAILABLE');}
  finally{if(file)try{await file.close();}catch{throw new Error('B2B_OPERATIONAL_POLICY_UNAVAILABLE');}}
 }
 toJSON(){return {policy:'B2bLocalOperations',configured:true};}
 [inspect.custom](){return 'FileB2bOperationalPolicy { path: [PRIVATE] }';}
}
