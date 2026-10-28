import {readFileSync,lstatSync,openSync,fstatSync,closeSync,readSync,realpathSync,constants} from 'node:fs';
import {isAbsolute,resolve,join,parse} from 'node:path';
/** Explicit mounted files only. No env-file loading, default roots, discovery or
 * arbitrary names from request bodies. No private data in errors/inspection. */
export class B2bRuntimeFiles {
 #root:string;
 constructor(root:string){
  if(typeof root!=='string'||!isAbsolute(root)||resolve(root)===parse(root).root)throw Error('B2B_PRIVATE_CONFIG_ROOT_REQUIRED');
  const r=resolve(root),s=lstatSync(r);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(r)!==r)throw Error('B2B_CONFIG_ROOT_INVALID');
  if(process.platform!=='win32'&&(s.mode&0o022)!==0)throw Error('B2B_CONFIG_ROOT_WRITABLE_BY_OTHERS');this.#root=r;
 }
 private bytes(name:string,secret:boolean,maximum:number){
  if(!/^[a-z][a-z0-9-]{0,63}\.(json|pem|key|crt|bin)$/.test(name))throw Error('B2B_CONFIG_NAME_INVALID');
  const path=join(this.#root,name);let fd:number|undefined;
  try{
   const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>maximum)throw Error();
   if(secret&&process.platform!=='win32'&&(before.mode&0o077)!==0)throw Error();
   fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const stat=fstatSync(fd);
   if(stat.dev!==before.dev||stat.ino!==before.ino||stat.size!==before.size)throw Error();
   const buffer=Buffer.alloc(stat.size);let offset=0;while(offset<buffer.length){const n=readSync(fd,buffer,offset,buffer.length-offset,null);if(!n)throw Error();offset+=n;}
   const after=fstatSync(fd);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error();return buffer;
  }catch{throw Error('B2B_MOUNTED_CONFIGURATION_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}
 }
 metadata(name='runtime.json'){try{const value=JSON.parse(this.bytes(name,false,65536).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error();return value as Record<string,any>;}catch{throw Error('B2B_RUNTIME_METADATA_INVALID');}}
 publicPem(name:string){return this.bytes(name,false,32768);}
 privatePem(name:string){return this.bytes(name,true,32768);}
 secretBytes(name:string){return this.bytes(name,true,4096);}
 /** Bounded mounted PKCS#12 bytes; callers own and must erase the returned copy. */
 privateBinary(name:string){return this.bytes(name,true,512*1024);}
 toJSON(){return {service:'B2bRuntimeFiles',contents:'PRIVATE'};}
}
