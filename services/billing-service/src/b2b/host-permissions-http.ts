import { request } from 'node:https';
import { inspect } from 'node:util';
import { billingAuthorityPath, billingHash, billingPermissionFailure, billingSnapshot } from './host-permissions-wire';
import { checkServerIdentity } from 'node:tls';

export interface BillingAuthorityTransport { post(body: unknown, token?: string): Promise<unknown> }
export interface BillingAuthorityTls { ca: Buffer; cert: Buffer; key: Buffer; serverFingerprintSha256: string }
/** Dedicated fixed RPC because B2bPrivateHttp intentionally does not allow this new path.
 * Parent supplies dedicated Billing credentials; no shared whitelist or environment is changed. */
export class BillingAuthorityHttps implements BillingAuthorityTransport {
  #origin: URL; #tls!: BillingAuthorityTls;
  constructor(origin: string, tls: BillingAuthorityTls) {
    this.#origin = new URL(origin);
    if (this.#origin.protocol !== 'https:' || this.#origin.pathname !== '/' || this.#origin.username || this.#origin.password ||
        this.#origin.search || this.#origin.hash || !/^[a-f0-9]{64}$/.test(tls.serverFingerprintSha256) ||
        ![tls.ca,tls.cert,tls.key].every(v=>Buffer.isBuffer(v)&&v.length>0)) return billingPermissionFailure();
    this.#tls = {ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key),serverFingerprintSha256:tls.serverFingerprintSha256};
  }
  async post(body: unknown, token?: string): Promise<unknown> {
    if (token !== undefined && !/^[A-Za-z0-9._~-]{16,8192}$/.test(token)) return billingPermissionFailure(401);
    const bytes = Buffer.from(JSON.stringify(billingSnapshot(body)));
    if (bytes.length > 16384) return billingPermissionFailure(400);
    return new Promise((resolve,reject)=>{
      const deny = () => reject(new Error('BILLING_AUTHORITY_TRANSPORT_UNAVAILABLE'));
      const req = request(new URL(billingAuthorityPath,this.#origin),{...this.#tls,method:'POST',agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',
        checkServerIdentity:(host,cert)=>checkServerIdentity(host,cert)??(billingHash(cert.raw)===this.#tls.serverFingerprintSha256?undefined:new Error('PRIVATE_SERVER_REQUIRED')),
        headers:{'Content-Type':'application/json','Content-Length':bytes.length,Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{
        const chunks:Buffer[]=[]; let size=0;
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>256*1024)req.destroy();else chunks.push(chunk);});
        res.on('error',deny); res.on('aborted',deny);
        res.on('end',()=>{
          if (res.statusCode !== 200 || !/^application\/json(?:;|$)/.test(String(res.headers['content-type']??'')) ||
              String(res.headers['cache-control']) !== 'private, no-store') return deny();
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { deny(); }
        });
      });
      const timer=setTimeout(()=>req.destroy(),15000);timer.unref(); req.on('close',()=>clearTimeout(timer));
      req.on('error',deny);req.end(bytes);
    }).catch(()=>billingPermissionFailure());
  }
  toJSON(){return {service:'BillingAuthorityHttps',contents:'PRIVATE'};}
  [inspect.custom](){return this.toJSON();}
}


