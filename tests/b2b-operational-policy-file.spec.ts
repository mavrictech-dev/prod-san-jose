import {describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rename,link,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {inspect} from 'node:util';
import {FileB2bOperationalPolicy} from '../services/b2b-api-service/src/operational-policy-file';
async function fixture(work:(root:string,path:string,policy:FileB2bOperationalPolicy)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'factuez-operations-synthetic-'));
 try{await work(root,join(root,'b2b-operations.json'),new FileB2bOperationalPolicy(root));}
 finally{await rm(root,{recursive:true,force:true});}
}
describe('operator policy: one explicit local metadata file, never credentials',()=>{
 it('reads PAUSED by default example and sees atomic revised OPEN without caching authority',async()=>{
  await fixture(async(root,path,policy)=>{
   await writeFile(path,JSON.stringify({environment:'BETA',revision:1,mode:'PAUSED'}));expect(await policy.current()).toMatchObject({environment:'BETA',revision:1,mode:'PAUSED'});
   const replacement=join(root,'replacement.json');await writeFile(replacement,JSON.stringify({environment:'BETA',revision:2,mode:'OPEN'}));await rename(replacement,path);
   const value=await policy.current();expect(value.mode).toBe('OPEN');expect(Date.parse(value.expiresAt)-Date.now()).toBeGreaterThan(0);expect(Date.parse(value.expiresAt)-Date.now()).toBeLessThanOrEqual(5000);
   expect(JSON.stringify(policy)).not.toContain(root);expect(inspect(policy)).not.toContain(root);
  });
 });
 it.each(['', '{"environment":"PRODUCTION","revision":1,"mode":"OPEN"}', '{"environment":"BETA","revision":0,"mode":"OPEN"}',
  '{"environment":"BETA","revision":1,"mode":"OPEN","password":"PRIVATE"}',
  '{"environment":"BETA","revision":1,"mode":"PAUSED","mode":"OPEN"}',
  '{"environment":"BETA","revision":1,"mode":"PAUSED","\\u006dode":"OPEN"}',
  'PRIVATE'.repeat(500), 'null', '[]'])('rejects malformed/secret/oversized metadata with a closed error',async text=>{
  await fixture(async(_root,path,policy)=>{await writeFile(path,text);await expect(policy.current()).rejects.toThrow(/^B2B_OPERATIONAL_POLICY_UNAVAILABLE$/);});
 });
 it('missing path and directories do not fall back to defaults or any other file',async()=>{
  await fixture(async(_root,path,policy)=>{await expect(policy.current()).rejects.toThrow('UNAVAILABLE');await mkdir(path);await expect(policy.current()).rejects.toThrow('UNAVAILABLE');});
 });
 it('rejects a hardlinked metadata file',async()=>{
  await fixture(async(root,path,policy)=>{const other=join(root,'unrelated.json');await writeFile(other,'{"environment":"BETA","revision":1,"mode":"OPEN"}');await link(other,path);await expect(policy.current()).rejects.toThrow('UNAVAILABLE');});
 });
 it('rejects a redirected parent directory including a Windows junction',async()=>{
  await fixture(async(root,_path,_policy)=>{
   const actual=join(root,'actual'),redirect=join(root,'redirect');await mkdir(actual);await writeFile(join(actual,'b2b-operations.json'),'{"environment":"BETA","revision":1,"mode":"OPEN"}');
   await symlink(actual,redirect,process.platform==='win32'?'junction':'dir');await expect(new FileB2bOperationalPolicy(redirect).current()).rejects.toThrow('UNAVAILABLE');
  });
 });
 it('requires an explicitly absolute directory and makes no I/O at construction',()=>{
  for(const root of ['', 'relative-path', 'https://PRIVATE.invalid'])expect(()=>new FileB2bOperationalPolicy(root)).toThrow('DIRECTORY_REQUIRED');
 });
});
