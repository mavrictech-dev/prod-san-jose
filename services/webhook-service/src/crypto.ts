import {createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {Webhook} from 'standardwebhooks';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';

export interface HookVaultKeyring {
  activeKeyVersion:string;
  keys:readonly {version:string;key:Buffer}[];
  /** Explicit migration mapping; never guess a key for unversioned ciphertext. */
  legacyKeyVersion?:string;
}
export const HOOK_VAULT_MAX_CIPHERTEXT=512;
const vaultSchema='factuez.hook-vault.v1';
const validVersion=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v)&&v!=='legacy';
const unavailable=()=>new B2bSecurityError(503,'SIGNING_KEY_UNAVAILABLE');
const aad=(id:string,version:string)=>Buffer.from(JSON.stringify([vaultSchema,id,version]));
function unpack(value:string){
  if(!/^[A-Za-z0-9+/]{104}$/.test(value))throw unavailable();
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==78||bytes.toString('base64')!==value)throw unavailable();
  return bytes;
}
/** Dedicated custody keys only. Runtime-private fields also hide keys from inspect/JSON. */
export class HookVault {
  #keys=new Map<string,Buffer>();
  #active:string;
  #legacy:string|undefined;
  #legacyWrites:boolean;
  constructor(config:Buffer|HookVaultKeyring){
    try{
      this.#legacyWrites=Buffer.isBuffer(config);
      if(Buffer.isBuffer(config)){
        if(config.length!==32)throw unavailable();
        this.#active='legacy';this.#legacy='legacy';this.#keys.set('legacy',Buffer.from(config));
      }else{
        if(!config||!Array.isArray(config.keys)||config.keys.length<1||config.keys.length>2||!validVersion(config.activeKeyVersion))throw unavailable();
        this.#active=config.activeKeyVersion;
        for(const entry of config.keys){
          if(!entry||!validVersion(entry.version)||!Buffer.isBuffer(entry.key)||entry.key.length!==32||this.#keys.has(entry.version)||[...this.#keys.values()].some(k=>k.equals(entry.key)))throw unavailable();
          this.#keys.set(entry.version,Buffer.from(entry.key));
        }
        if(!this.#keys.has(this.#active)||config.legacyKeyVersion!==undefined&&!this.#keys.has(config.legacyKeyVersion))throw unavailable();
        this.#legacy=config.legacyKeyVersion;
      }
    }catch{throw unavailable();}
  }
  metadata(){return {schemaVersion:vaultSchema,activeKeyVersion:this.#active,readableKeyVersions:[...this.#keys.keys()],legacyKeyVersion:this.#legacy??null};}
  /** Syntax metadata only; open() is still required to authenticate it. */
  ciphertextVersion(value:string){
    try{
      if(typeof value!=='string'||value.length>HOOK_VAULT_MAX_CIPHERTEXT)throw unavailable();
      if(!value.includes('.')){unpack(value);return 'legacy';}
      const parts=value.split('.');
      if(parts.length!==4||parts[0]!=='hookvault'||parts[1]!=='1'||!validVersion(parts[2]))throw unavailable();
      unpack(parts[3]);return parts[2];
    }catch{throw unavailable();}
  }
  seal(secret:string,id:string){
    try{
      if(typeof id!=='string'||!id||id.length>256)throw unavailable();
      keyBytes(secret);
      const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.#keys.get(this.#active)!,iv);
      c.setAAD(this.#legacyWrites?Buffer.from(id):aad(id,this.#active));
      const bytes=Buffer.concat([c.update(secret,'utf8'),c.final()]);
      const payload=Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64');
      return this.#legacyWrites?payload:`hookvault.1.${this.#active}.${payload}`;
    }catch{throw unavailable();}
  }
  open(value:string,id:string){
    try{
      if(typeof id!=='string'||!id||id.length>256)throw unavailable();
      const version=this.ciphertextVersion(value),legacy=version==='legacy';
      const key=this.#keys.get(legacy?this.#legacy??'':version);if(!key)throw unavailable();
      const b=unpack(legacy?value:value.split('.')[3]);
      const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));
      d.setAAD(legacy?Buffer.from(id):aad(id,version));d.setAuthTag(b.subarray(12,28));
      const secret=Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');keyBytes(secret);return secret;
    }catch{throw unavailable();}
  }
}
export const newSigningSecret=()=> 'whsec_'+randomBytes(32).toString('base64');
function keyBytes(secret:string){if(!/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret))throw new Error('Invalid signing secret');const key=Buffer.from(secret.slice(6),'base64');if(key.length!==32)throw new Error('Invalid signing secret');return key;}
/** Maintained Standard Webhooks SDK; JSON is signed as exact well-formed UTF-8 bytes. */
export function signWebhook(secret:string,id:string,timestamp:number,body:Buffer){
  if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(timestamp)||timestamp<1||body.length>16384||!Buffer.from(body.toString('utf8')).equals(body))throw new Error('Invalid webhook signing input');
  keyBytes(secret);return new Webhook(secret).sign(id,new Date(timestamp*1000),body);
}
export function verifyWebhook(secrets:readonly string[],body:Buffer,headers:Record<string,unknown>,now=Date.now()){
  const id=headers['webhook-id'],ts=headers['webhook-timestamp'],sig=headers['webhook-signature'];
  if(typeof id!=='string'||typeof ts!=='string'||!/^[1-9][0-9]{0,10}$/.test(ts)||typeof sig!=='string'||sig.length>512||Math.abs(Math.floor(now/1000)-Number(ts))>300)throw new Error('Invalid webhook');
  const values=sig.split(' ');let matched=false;
  for(const secret of secrets){const expected=Buffer.from(signWebhook(secret,id,Number(ts),body));for(const value of values){const actual=Buffer.from(value);matched=actual.length===expected.length&&timingSafeEqual(actual,expected)||matched;}}
  if(!matched)throw new Error('Invalid webhook');return id;
}
