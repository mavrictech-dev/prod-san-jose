import {inspect} from 'node:util';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {smtpHostname} from '../smtp-configuration.policy';
const invalid=()=>Error('B2B_MAILER_SMTP_MOUNT_INVALID');
/** Private mount result; no key bytes in JSON/inspection. Parent copies into the
 * owner resource, then calls close() to erase this temporary mounted buffer. */
export class MailerSmtpOwnerMount {
 #key:Buffer;#closed=false;#keyVersion:number;#hosts:readonly string[];
 constructor(key:Buffer,keyVersion:number,hosts:readonly string[]){
  if(!Buffer.isBuffer(key)||key.length!==32||!Number.isInteger(keyVersion)||keyVersion<1||keyVersion>10000||
   !Array.isArray(hosts)||hosts.length<1||hosts.length>16||hosts.some(h=>!smtpHostname(h))||new Set(hosts).size!==hosts.length)throw invalid();
  this.#key=key;this.#keyVersion=keyVersion;this.#hosts=Object.freeze([...hosts]);
 }
 get key(){if(this.#closed)throw invalid();return this.#key;}
 get keyVersion(){return this.#keyVersion;}
 get approvedHosts(){return this.#hosts;}
 close(){this.#closed=true;this.#key.fill(0);}
 toJSON(){return {service:'MailerSmtpOwnerMount',environment:'BETA',profile:'PREPARED_ONLY',closed:this.#closed};}
 [inspect.custom](){return this.toJSON();}
}
/** Exactly two fixed mounted files, no .env, discovery, DB, TLS client or SMTP I/O.
 * smtp-host.json keys are exact and smtp-key.bin is raw binary (not hex/base64). */
export function loadMailerSmtpOwnerMount(root:string):MailerSmtpOwnerMount {
 let key:Buffer|undefined;
 try{
  const files=new B2bRuntimeFiles(root),metadata=files.metadata('smtp-host.json');
  if(Object.keys(metadata).sort().join(',')!=='approvedHosts,environment,keyFile,keyVersion,profile,schemaVersion'||
   metadata.schemaVersion!=='factuez.b2b.mailer-smtp-host.v1'||metadata.environment!=='BETA'||metadata.profile!=='PREPARED_ONLY'||metadata.keyFile!=='smtp-key.bin'||
   !Number.isInteger(metadata.keyVersion)||metadata.keyVersion<1||metadata.keyVersion>10000||!Array.isArray(metadata.approvedHosts)||metadata.approvedHosts.length<1||metadata.approvedHosts.length>16||
   metadata.approvedHosts.some((host:unknown)=>!smtpHostname(host))||new Set(metadata.approvedHosts).size!==metadata.approvedHosts.length)throw invalid();
  key=files.secretBytes('smtp-key.bin');return new MailerSmtpOwnerMount(key,metadata.keyVersion,metadata.approvedHosts);
 }catch{key?.fill(0);throw invalid();}
}
