import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import { B2bAudience } from '@factuez/contracts/b2b';
import { fail, plain, scopeText, uuid, type Client } from './model';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string): Record<string, any> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!plain(parsed) || encode(parsed) !== value) throw new Error();
    return parsed;
  } catch { return fail(401, 'INVALID_TOKEN'); }
}
/** Operator-only overlap for one previous PUBLIC SPKI key. No old private key,
 * URLs, discovery, credentials, environment loading or implicit activation. */
export interface B2bTokenRotation {
  previous: {publicKey:Buffer;cutoverAt:number};
}
const publicKid=(key:KeyObject)=>createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
const rsa=(key:KeyObject)=>key.asymmetricKeyType==='rsa'&&(key.asymmetricKeyDetails?.modulusLength??0)>=2048;
function dataObject(value:unknown,keys:string[]):value is Record<string,any>{
  return !!value&&typeof value==='object'&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype&&
    Reflect.ownKeys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k))&&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>d.enumerable&&'value'in d);
}
export class B2bTokenCodec {
  private readonly key: KeyObject;
  private readonly publicKey: KeyObject;
  readonly kid: string;
  #previous?:{key:KeyObject;kid:string;cutoverAt:number;expiresAt:number;deadline:number;retired:boolean};
  #latestTime=-1;
  constructor(pem: Buffer, readonly issuer: string, private readonly now: () => number, otherKeys: { human: Buffer; integration: Buffer; tls: Buffer }, rotation?:B2bTokenRotation) {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Fixed HTTPS B2B issuer required');
    this.key = createPrivateKey(pem); this.publicKey = createPublicKey(this.key);
    if (!rsa(this.key)) throw new Error('Dedicated RSA B2B key required');
    const der = this.publicKey.export({ format: 'der', type: 'spki' });
    if (!otherKeys || ['human','integration','tls'].some(name => !otherKeys[name as keyof typeof otherKeys])) throw new Error('Existing public keys required to check separation');
    if (Object.values(otherKeys).some(key => createPublicKey(key).export({ format: 'der', type: 'spki' }).equals(der))) throw new Error('B2B key must differ from human, integration and TLS keys');
    this.kid = createHash('sha256').update(der).digest('hex');
    if(rotation!==undefined){
      if(!dataObject(rotation,['previous'])||!dataObject(rotation.previous,['publicKey','cutoverAt']))throw new Error('EXPLICIT_B2B_KEY_ROTATION_REQUIRED');
      const p=rotation.previous,current=this.time();
      if(!Buffer.isBuffer(p.publicKey)||types.isProxy(p.publicKey)||p.publicKey.length>16384||
        !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(p.publicKey.toString('ascii'))||
        !Number.isSafeInteger(p.cutoverAt)||p.cutoverAt<0||p.cutoverAt>current||p.cutoverAt>Number.MAX_SAFE_INTEGER-300)throw new Error('INVALID_B2B_PREVIOUS_PUBLIC_KEY');
      let key:KeyObject;try{key=createPublicKey(Buffer.from(p.publicKey));}catch{throw new Error('INVALID_B2B_PREVIOUS_PUBLIC_KEY');}
      const kid=publicKid(key);
      if(!rsa(key)||kid===this.kid||Object.values(otherKeys).some(v=>publicKid(createPublicKey(v))===kid))throw new Error('B2B_ROTATION_KEY_SEPARATION_REQUIRED');
      const expiresAt=p.cutoverAt+300;
      this.#previous={key,kid,cutoverAt:p.cutoverAt,expiresAt,deadline:performance.now()+Math.max(0,expiresAt-current)*1000,retired:current>=expiresAt};
    }
  }
  private time(){
    const value=this.now();
    if(!Number.isSafeInteger(value)||value<0||value>Number.MAX_SAFE_INTEGER-300||value<this.#latestTime)return fail(503,'TOKEN_CLOCK_UNAVAILABLE');
    this.#latestTime=value;return value;
  }
  private previous(current:number){
    const p=this.#previous;if(!p)return null;
    if(current>=p.expiresAt||performance.now()>=p.deadline)p.retired=true;
    return p.retired?null:p;
  }
  mint(client: Client, selected: string[]) {
    if (client.kind !== 'SERVICE') return fail(403, 'CLIENT_KIND_NOT_ALLOWED');
    const now = this.time();
    const payload = { iss: this.issuer, aud: B2bAudience, sub: client.id, client_id: client.id,
      jti: randomUUID(), iat: now, nbf: now, exp: now + 300, scope: selected.join(' '),
      revision: client.revision, kind: 'SERVICE', environment: 'BETA' };
    const input = encode({ alg: 'RS256', typ: 'at+jwt', kid: this.kid }) + '.' + encode(payload);
    return input + '.' + sign('RSA-SHA256', Buffer.from(input), this.key).toString('base64url');
  }
  verify(token: unknown) {
    if (typeof token !== 'string' || token.length > 8192) return fail(401, 'INVALID_TOKEN');
    const parts = token.split('.'); if (parts.length !== 3) return fail(401, 'INVALID_TOKEN');
    const header = decode(parts[0]);
    const current=this.time(),previous=this.previous(current),key=header.kid===this.kid?this.publicKey:previous&&header.kid===previous.kid?previous.key:null;
    if (Object.keys(header).sort().join(',') !== 'alg,kid,typ' || header.alg !== 'RS256' || header.typ !== 'at+jwt' || !key || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return fail(401, 'INVALID_TOKEN');
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.toString('base64url') !== parts[2] || !verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), key, signature)) return fail(401, 'INVALID_TOKEN');
    const value = decode(parts[1]);
    if (Object.keys(value).sort().join(',') !== 'aud,client_id,environment,exp,iat,iss,jti,kind,nbf,revision,scope,sub' ||
      value.iss !== this.issuer || value.aud !== B2bAudience || value.kind !== 'SERVICE' || value.environment !== 'BETA' ||
      !uuid(value.sub) || value.client_id !== value.sub || !uuid(value.jti) ||
      ![value.iat, value.nbf, value.exp, value.revision].every(Number.isSafeInteger) || value.revision < 1 ||
      value.iat !== value.nbf || value.iat<0 || value.iat > current || value.exp <= current || value.exp - value.iat !== 300 ||
      (previous&&header.kid===previous.kid&&value.iat>previous.cutoverAt)) return fail(401, 'INVALID_TOKEN');
    try { scopeText(value.scope); } catch { return fail(401, 'INVALID_TOKEN'); }
    return value as { client_id: string; revision: number; scope: string };
  }
  jwks() {
    const previous=this.previous(this.time()),keys=[{...this.publicKey.export({format:'jwk'}),kid:this.kid,alg:'RS256',use:'sig'}];
    if(previous)keys.push({...previous.key.export({format:'jwk'}),kid:previous.kid,alg:'RS256',use:'sig'});
    return {keys};
  }
  /** Private operator metadata, not an authorization or a public route. */
  rotationStatus(){
    const previous=this.previous(this.time());
    return {schemaVersion:'factuez.b2b.signing-keys.v1',environment:'BETA',activeKid:this.kid,
      previousKid:this.#previous?.kid??null,state:previous?'OVERLAP':this.#previous?'RETIRED':'SINGLE_KEY',
      cutoverAt:this.#previous?.cutoverAt??null,previousVerifyUntil:this.#previous?.expiresAt??null,tokenLifetimeSeconds:300};
  }
}
