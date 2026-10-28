import {createServer,request,type Server} from 'node:https';
import {randomUUID} from 'node:crypto';
import type {TLSSocket} from 'node:tls';
import {types} from 'node:util';
import {b2bManagedServices,type B2bManagedInstance,type B2bMaintenancePhase,type B2bQuiescePort,type B2bQuiesceReceipt,type B2bQuiesceRequest} from './b2b-deployment-maintenance';
const phases=['ADMISSION','PRODUCERS','WORKERS','STORAGE'] as const;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fingerprint=(socket:TLSSocket)=>socket.encrypted&&socket.authorized?socket.getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase():undefined;
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&
 keys.every(k=>Object.hasOwn(v,k))&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>d.enumerable&&'value'in d);
export type B2bMaintenanceHooks=Record<B2bMaintenancePhase,()=>Promise<void>>;
/** Separate operator listener survives closing all business listeners/pools.
 * No commands, bearer auth, TLS bypass, discovery, automatic start or reopen. */
export class B2bMaintenanceNode implements B2bQuiescePort {
 #deploymentId:string;#instance:B2bManagedInstance;#hooks:B2bMaintenanceHooks;
 #runId:string|null=null;#sha:string|null=null;#index=-1;#failed=false;#pending?:{phase:B2bMaintenancePhase;promise:Promise<B2bQuiesceReceipt>};
 #receipts=new Map<B2bMaintenancePhase,B2bQuiesceReceipt>();#enabled:boolean;#server?:Server;
 constructor(options:{enabled?:boolean;deploymentId:string;instance:B2bManagedInstance;hooks:B2bMaintenanceHooks}){
  if(!exact(options,['enabled','deploymentId','instance','hooks'])||typeof options.enabled!=='boolean'||!uuid(options.deploymentId)||
   !exact(options.instance,['service','instanceId','bootId'])||!Object.hasOwn(b2bManagedServices,options.instance.service)||!uuid(options.instance.instanceId)||!uuid(options.instance.bootId)||
   !exact(options.hooks,[...phases])||phases.some(p=>typeof options.hooks[p]!=='function'))throw Error('EXPLICIT_MAINTENANCE_NODE_REQUIRED');
  this.#deploymentId=options.deploymentId;this.#instance=structuredClone(options.instance);this.#hooks={...options.hooks};this.#enabled=options.enabled===true;
 }
 snapshot(){return {schemaVersion:'factuez.b2b.maintenance-node.v1',environment:'BETA',deploymentId:this.#deploymentId,instance:structuredClone(this.#instance),
  runId:this.#runId,inventorySha256:this.#sha,state:!this.#enabled?'DISABLED':this.#failed?'FAILED':this.#pending?'STOPPING':this.#index===3?'PARKED':'READY',
  completedPhase:this.#index<0?null:phases[this.#index],pending:this.#pending?1:0,storageClosed:this.#index===3&&!this.#failed};}
 advance(phase:B2bMaintenancePhase,raw:B2bQuiesceRequest):Promise<B2bQuiesceReceipt>{
  if(!this.#enabled||this.#failed)return Promise.reject(Error('MAINTENANCE_NOT_ADMITTED'));
  if(!phases.includes(phase)||!exact(raw,['runId','deploymentId','inventorySha256','instance'])||!uuid(raw.runId)||raw.deploymentId!==this.#deploymentId||!hex(raw.inventorySha256)||
   !exact(raw.instance,['service','instanceId','bootId'])||raw.instance.service!==this.#instance.service||raw.instance.instanceId!==this.#instance.instanceId||raw.instance.bootId!==this.#instance.bootId)
   return Promise.reject(Error('MAINTENANCE_INSTANCE_MISMATCH'));
  if(this.#runId!==null&&(this.#runId!==raw.runId||this.#sha!==raw.inventorySha256))return Promise.reject(Error('MAINTENANCE_RUN_CONFLICT'));
  if(this.#receipts.has(phase))return Promise.resolve(structuredClone(this.#receipts.get(phase)!));
  if(this.#pending)return this.#pending.phase===phase?this.#pending.promise.then(r=>structuredClone(r)):Promise.reject(Error('MAINTENANCE_PHASE_IN_PROGRESS'));
  if(phases.indexOf(phase)!==this.#index+1)return Promise.reject(Error('MAINTENANCE_PHASE_ORDER'));
  this.#runId=raw.runId;this.#sha=raw.inventorySha256;const request=structuredClone(raw);
  const promise=Promise.resolve().then(()=>this.#hooks[phase]()).then(()=>{
   this.#index=phases.indexOf(phase);const receipt:B2bQuiesceReceipt={...request,phase,state:'QUIESCED_PHASE',pending:0,storageClosed:phase==='STORAGE'};
   this.#receipts.set(phase,structuredClone(receipt));return receipt;
  },()=>{this.#failed=true;throw Error('MAINTENANCE_HOOK_FAILED');}).finally(()=>{this.#pending=undefined;});
  this.#pending={phase,promise};return promise.then(r=>structuredClone(r));
 }
 async listen(options:{host:'127.0.0.1'|'0.0.0.0';port:number;tls:{ca:Buffer;cert:Buffer;key:Buffer};operatorPeers:string[]}){
  if(!this.#enabled||this.#server||!['127.0.0.1','0.0.0.0'].includes(options.host)||!Number.isInteger(options.port)||options.port<0||options.port>65535||
   !Array.isArray(options.operatorPeers)||!options.operatorPeers.length||options.operatorPeers.length>32||options.operatorPeers.some(p=>!hex(p))||new Set(options.operatorPeers).size!==options.operatorPeers.length)throw Error('PRIVATE_MAINTENANCE_LISTENER_REQUIRED');
  const peers=[...options.operatorPeers];
  const server=createServer({...options.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:8192},async(req,res)=>{
   const send=(status:number,value:unknown)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
   if(!peers.includes(fingerprint(req.socket as TLSSocket)??''))return send(403,{code:'OPERATOR_PEER_REQUIRED'});
   const names=req.rawHeaders.filter((_v,i)=>i%2===0).map(v=>v.toLowerCase());if(new Set(names).size!==names.length||req.headers.authorization||req.headers['transfer-encoding'])return send(400,{code:'INVALID_MAINTENANCE_REQUEST'});
   if(req.method==='GET'&&req.url==='/internal/maintenance/status'&&!req.headers['content-length'])return send(200,this.snapshot());
   if(req.method!=='POST'||req.url!=='/internal/maintenance/advance'||!/^application\/json(?:;|$)/.test(req.headers['content-type']??'')||
    !/^[1-9][0-9]{0,3}$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>8192)return send(400,{code:'INVALID_MAINTENANCE_REQUEST'});
   const chunks:Buffer[]=[];let bytes=0;
   try{for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw Error();chunks.push(Buffer.from(chunk));}
    const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!exact(raw,['phase','request']))throw Error();const r=await this.advance(raw.phase,raw.request);send(200,r);
   }catch{send(409,{code:'MAINTENANCE_NOT_COMPLETED'});}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=1000;server.maxConnections=8;this.#server=server;
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,options.host,()=>{server.off('error',reject);resolve();});});}
  catch{this.#server=undefined;server.close();throw Error('MAINTENANCE_LISTENER_START_FAILED');}
  return server.address();
 }
 async closeListener(){if(this.#pending)throw Error('MAINTENANCE_WORK_ACTIVE');const s=this.#server;this.#server=undefined;if(s)await new Promise<void>((resolve,reject)=>s.close(e=>e?reject(Error('MAINTENANCE_LISTENER_CLOSE_FAILED')):resolve()));}
 toJSON(){return this.snapshot();}
}

/** Fixed operator RPC, dedicated mTLS identity. Not accessible through the
 * B2B resource transport or public Kong paths. No redirects or fallback. */
export class HttpsB2bMaintenancePort implements B2bQuiescePort {
 #origin:URL;#tls:{ca:Buffer;cert:Buffer;key:Buffer};#pin:string;
 constructor(origin:string,tls:{ca:Buffer;cert:Buffer;key:Buffer},serverFingerprint:string){
  const url=new URL(origin);if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||!hex(serverFingerprint))throw Error('FIXED_MAINTENANCE_ORIGIN_REQUIRED');
  this.#origin=url;this.#tls={ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)};this.#pin=serverFingerprint;
 }
 private exchange(path:string,body?:unknown):Promise<any>{
  const data=body===undefined?undefined:Buffer.from(JSON.stringify(body));if(data&&data.length>8192)return Promise.reject(Error('MAINTENANCE_REQUEST_TOO_LARGE'));
  return new Promise((resolve,reject)=>{
   const req=request(new URL(path,this.#origin),{...this.#tls,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',method:data?'POST':'GET',timeout:60000,
    headers:data?{'Content-Type':'application/json','Content-Length':data.length}:{Accept:'application/json'}},res=>{
     res.on('error',()=>reject(Error('MAINTENANCE_TRANSPORT_FAILED')));
     let pin:string|undefined;try{pin=(res.socket as TLSSocket).getPeerCertificate(true).fingerprint256?.replace(/:/g,'').toLowerCase();}catch{/* Reject missing peer evidence. */}
     if(pin!==this.#pin){req.destroy(Error('MAINTENANCE_SERVER_MISMATCH'));return;}
     const chunks:Buffer[]=[];let size=0;res.on('data',b=>{size+=b.length;if(size>16384)req.destroy(Error('MAINTENANCE_RESPONSE_TOO_LARGE'));else chunks.push(b);});
     res.on('aborted',()=>reject(Error('MAINTENANCE_TRANSPORT_FAILED')));
     res.on('end',()=>{if(res.statusCode!==200)return reject(Error('MAINTENANCE_REQUEST_DENIED'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('MAINTENANCE_RESPONSE_INVALID'));}});
    });req.on('error',()=>reject(Error('MAINTENANCE_TRANSPORT_FAILED')));req.on('timeout',()=>req.destroy(Error('MAINTENANCE_TRANSPORT_TIMEOUT')));req.end(data);
  });
 }
 advance(phase:B2bMaintenancePhase,request:B2bQuiesceRequest){return this.exchange('/internal/maintenance/advance',{phase,request}) as Promise<B2bQuiesceReceipt>;}
 status(){return this.exchange('/internal/maintenance/status');}
}

/** Reuse an already parked/coordinating run on SIGTERM. Never manufacture a
 * conflicting maintenance id or kill in-flight work to meet a stop deadline. */
export async function stopB2bMaintenanceNode(node:B2bMaintenanceNode){
 const s=node.snapshot(),request={runId:s.runId??randomUUID(),deploymentId:s.deploymentId,inventorySha256:s.inventorySha256??'0'.repeat(64),instance:s.instance};
 for(const phase of phases)await node.advance(phase,request);await node.closeListener();
}
