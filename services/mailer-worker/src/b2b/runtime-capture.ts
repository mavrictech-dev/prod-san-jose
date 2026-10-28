import {lstatSync,realpathSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve,parse,isAbsolute,join} from 'node:path';
import type {EmailDeliveryLocalCaptureSink} from './email-deliveries.capture';
import {emailHash,emailUuid} from './email-deliveries';
/** Existing dedicated local directory only. Exclusive files and fsync before acknowledgement.
 * A partial file is never retried/overwritten; the core journals UNKNOWN on any ambiguity. */
export class B2bMailerFileCapture implements EmailDeliveryLocalCaptureSink {
 #root:string;
 constructor(root:string){
  if(!isAbsolute(root)||resolve(root)===parse(root).root)throw Error('B2B_MAILER_CAPTURE_ROOT_REQUIRED');
  this.#root=resolve(root);this.check();
 }
 check(){
  const s=lstatSync(this.#root);
  if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(this.#root)!==this.#root||process.platform!=='win32'&&(s.mode&0o077)!==0)throw Error('B2B_MAILER_CAPTURE_ROOT_INVALID');
 }
 async writeLocalCapture(value:Readonly<{jobId:string;attemptId:string;sha256:string;eml:Uint8Array}>){
  this.check();
  if(!emailUuid(value.jobId)||!emailUuid(value.attemptId)||!value.eml.length||value.eml.length>32*1024*1024||emailHash(value.eml)!==value.sha256)throw Error('B2B_MAILER_CAPTURE_INVALID');
  const file=await open(join(this.#root,value.jobId+'-'+value.attemptId+'.eml'),'wx',0o600);
  try{await file.writeFile(value.eml);await file.sync();}finally{await file.close();}
  // Directory fsync persists the new entry on platforms that support it.
  if(process.platform!=='win32'){const dir=await open(this.#root,'r');try{await dir.sync();}finally{await dir.close();}}
 }
}
