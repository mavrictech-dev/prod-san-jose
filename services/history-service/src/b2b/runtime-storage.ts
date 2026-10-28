import {lstatSync,realpathSync,openSync,fstatSync,closeSync,readSync,constants} from 'node:fs';
import {join} from 'node:path';
import {HistoryArtifactStore} from '../artifact-store';
import type {B2bHistoryRuntimeConfig} from './runtime-config';
/** Only existing QA markers are read. No mkdir, repairs, staging or byte copies. */
export function historyRuntimeStorage(config:B2bHistoryRuntimeConfig){
 const store=new HistoryArtifactStore({...config.storage,markerId:config.markerId});
 const check=()=>{
  try{
   for(const root of [config.storage.sourceRoot,config.storage.archiveRoot]){
    const dir=lstatSync(root);if(!dir.isDirectory()||dir.isSymbolicLink()||realpathSync(root)!==root)throw Error();
    const path=join(root,'.history-qa-marker.json'),before=lstatSync(path);let fd:number|undefined;
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>512||realpathSync(path)!==path)throw Error();
    try{
     fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
     const initial=fstatSync(fd);if(initial.dev!==before.dev||initial.ino!==before.ino||initial.size!==before.size||initial.nlink!==1)throw Error();
     const bytes=Buffer.alloc(before.size+1),count=readSync(fd,bytes,0,bytes.length,0),after=fstatSync(fd),last=lstatSync(path);
     if(count!==before.size||[after,last].some(s=>s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs||s.nlink!==1))throw Error();
     const m=JSON.parse(bytes.subarray(0,count).toString('utf8'));
     if(!m||Object.keys(m).sort().join(',')!=='markerId,profile'||m.profile!=='factuez-history-storage-qa-v1'||m.markerId!==config.markerId)throw Error();
    }finally{if(fd!==undefined)closeSync(fd);}
   }
  }catch{throw Error('B2B_HISTORY_QA_STORAGE_NOT_READY');}
 };
 return {store,check};
}
