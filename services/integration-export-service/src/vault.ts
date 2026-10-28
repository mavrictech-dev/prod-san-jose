import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deny } from '@factuez/service-access/dist/integration';
import { ExportQuotas } from './model';
/** Key is supplied from a dedicated mounted secret, never a token or the issuer's certificate. */
export class ExportVault {
  #key:Buffer;
  constructor(key:Buffer) {if(!Buffer.isBuffer(key)||key.length!==32) throw new Error('Dedicated 256-bit export key required');this.#key=Buffer.from(key);}
  seal(bytes:Buffer,aad:string):Buffer {
    if(bytes.length>ExportQuotas.encryptedBytes) return deny(422,'EXPORT_TOO_LARGE');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(Buffer.from(aad));
    const result=Buffer.concat([cipher.update(bytes),cipher.final()]);
    return Buffer.concat([Buffer.from([1]),iv,cipher.getAuthTag(),result]);
  }
  open(value:Buffer,aad:string):Buffer {
    if(value.length<29 || value.length>ExportQuotas.encryptedBytes+29 || value[0]!==1) return deny(409,'INTEGRITY_FAILED');
    try {const decipher=createDecipheriv('aes-256-gcm',this.#key,value.subarray(1,13));decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(value.subarray(13,29));return Buffer.concat([decipher.update(value.subarray(29)),decipher.final()]);
    } catch {return deny(409,'INTEGRITY_FAILED');}
  }
  sealJson(value:unknown,aad:string) {return this.seal(Buffer.from(JSON.stringify(value)),aad);}
  openJson<T>(value:Buffer,aad:string):T {try{return JSON.parse(this.open(value,aad).toString('utf8')) as T;}catch{return deny(409,'INTEGRITY_FAILED');}}
}
