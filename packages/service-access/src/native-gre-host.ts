import {readFileSync} from 'node:fs';
import {createServer,type Server} from 'node:https';
import type {TLSSocket} from 'node:tls';
import {createPrivateKey,createPublicKey,type KeyObject} from 'node:crypto';
export type NativeGreHostConfig={version:'factuez.native-gre.host.v1';listener:{port:number;host:string;caFile:string;certFile:string;keyFile:string};peers:string[];remote?:{origin:string;serverFingerprint:string};identity?:{origin:string;serverFingerprint:string};signing?:{keyId:string;keyFile:string};ownerPublicKeys?:{keyId:string;file:string}[];sunatPublicKeys?:{keyId:string;file:string}[];cataloguesFile?:string;b2b?:{peers:string[];identity?:{origin:string;serverFingerprint:string};billing?:{origin:string;serverFingerprint:string};fiscal?:{origin:string;serverFingerprint:string}}};
export function loadNativeGreConfig():NativeGreHostConfig|null{
 if(!process.env.NATIVE_GRE_CONFIG_FILE){if(process.env.NATIVE_GRE_ENABLED==='true')throw Error('GRE_CONFIG_FILE_REQUIRED');return null;}
 const c=JSON.parse(readFileSync(process.env.NATIVE_GRE_CONFIG_FILE,'utf8')) as NativeGreHostConfig;
 if(c.version!=='factuez.native-gre.host.v1'||!c.listener||!Number.isSafeInteger(c.listener.port)||c.listener.port<1024||c.listener.port>65535||!['127.0.0.1','0.0.0.0'].includes(c.listener.host)||!c.peers?.length||c.peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw Error('GRE_HOST_CONFIG_INVALID');return c;
}
export function nativeGrePeer(request:{socket:TLSSocket},pins:readonly string[]){const s=request.socket,pin=s?.encrypted&&s.authorized&&s.getPeerCertificate().fingerprint256?.replaceAll(':','').toLowerCase();if(!pin||!pins.includes(pin))throw Error('GRE_PRIVATE_PEER_REQUIRED');}
export function nativeGreTls(c:NativeGreHostConfig,peer:{serverFingerprint:string}){return {ca:readFileSync(c.listener.caFile),cert:readFileSync(c.listener.certFile),key:readFileSync(c.listener.keyFile),serverFingerprint:peer.serverFingerprint};}
export function nativeGreKeys(rows:{keyId:string;file:string}[]|undefined):ReadonlyMap<string,KeyObject>{if(!rows?.length||new Set(rows.map(r=>r.keyId)).size!==rows.length)throw Error('GRE_PUBLIC_KEYS_REQUIRED');return new Map(rows.map(r=>[r.keyId,createPublicKey(readFileSync(r.file))]));}
export function nativeGreSigning(c:NativeGreHostConfig){if(!c.signing?.keyId||!c.signing.keyFile)throw Error('GRE_SIGNING_KEY_REQUIRED');return {keyId:c.signing.keyId,key:createPrivateKey(readFileSync(c.signing.keyFile))};}
/** A separate private mTLS listener shares registered Nest routes; guards still reject /internal on public HTTP. */
export async function startNativeGreListener(app:{getHttpAdapter():{getInstance():any};get(token:any):any},c=loadNativeGreConfig()):Promise<Server|undefined>{
 if(!c)return;const server=createServer({...nativeGreTls(c,{serverFingerprint:''}),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},app.getHttpAdapter().getInstance());
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(c.listener.port,c.listener.host,()=>{server.off('error',reject);resolve();});});
 // Registered by host modules as a lifecycle provider so shutdown waits for workers first.
 app.get('NATIVE_GRE_LISTENER').server=server;return server;
}
export class NativeGreListenerLifecycle {server?:Server;async onModuleDestroy(){if(this.server)await new Promise<void>(r=>this.server!.close(()=>r()));}}
