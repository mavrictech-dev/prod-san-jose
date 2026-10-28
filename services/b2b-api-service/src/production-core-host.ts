import {createServer,type Server} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {type ProductionActor,type ProductionGrant,type ProductionIntrospection,type ProductionBinding,type ProductionStore,deny} from '@factuez/service-access/dist/b2b-production-contract';
import {type ProductionCallbackTransport} from '@factuez/service-access/dist/b2b-production-callback';
import {type ProductionTls} from '@factuez/service-access/dist/b2b-production-transport';
import {productionBody,productionFailure,productionJson,productionPeer,requireProductionProfile} from '@factuez/service-access/dist/b2b-production-http';
import {ProductionFacade,productionOperations,type ProductionOperation,type ProductionOwnerAdapter} from './production-facade';
import {admitProductionNativeCommand} from './production-owner-adapter';
import {createProductionNativeBillingProviders,type ProductionBillingSql,type ProductionIssuePort,type ProductionNotesPort,type ProductionGuidesPort,ProductionNativeCatalogue} from './production-native-billing';
import {ProductionWebhooks} from './production-webhooks';
import {productionRouter} from './production-http';
import {ProductionNativeOutboxRelay} from './production-outbox';
export interface ProductionCoreIdentity extends ProductionIntrospection {
 token(authorization:unknown,body:unknown,peer:string):Promise<unknown>;
 mayDeliverWebhook(clientId:string,binding:ProductionBinding):Promise<boolean>;
}
export interface ProductionCoreHostOptions {
 profile:'B2B_PRODUCTION';store:ProductionStore;billing:ProductionBillingSql;
 native:{issue:ProductionIssuePort;notes:ProductionNotesPort;guides:ProductionGuidesPort};
 identity:(catalogue:ProductionNativeCatalogue)=>ProductionCoreIdentity;
 callbacks:ProductionCallbackTransport;attestation:{keyId:string;key:Buffer};vaultKey:Buffer;
 tls:ProductionTls;peers:readonly string[];
 /** Attach the separately authorized Identity client administration router if desired. */
 administrationHandler?:(req:IncomingMessage,res:ServerResponse)=>Promise<unknown>;
}
/** Dedicated PRODUCTION listener embedded in core. Requires concrete native SERVICE entrypoints.
 * No BETA owner imports, bootstrap, fullgraph bypass, HTTP impersonation or additional service process.
 * The host owns worker scheduling; tick() is bounded to one delivery per invocation. */
export function createProductionCoreHost(options:ProductionCoreHostOptions){
 requireProductionProfile(options.profile);if(!options.peers.length||options.peers.some(p=>!/^[a-f0-9]{64}$/.test(p))||![options.tls.ca,options.tls.cert,options.tls.key].every(b=>Buffer.isBuffer(b)&&b.length>0))throw Error('PRODUCTION_CORE_MTLS_REQUIRED');
 const {catalogue,providers}=createProductionNativeBillingProviders(options.billing,options.native),identity=options.identity(catalogue),keys=new Map([[options.attestation.keyId,Buffer.from(options.attestation.key)]]);
 const hooks=new ProductionWebhooks(options.store,options.callbacks,options.vaultKey,(id,b)=>identity.mayDeliverWebhook(id,b));
 const adapters:Partial<Record<ProductionOperation,ProductionOwnerAdapter>>={};for(const operation of Object.keys(providers) as Array<keyof typeof providers>){const provider=providers[operation];adapters[operation]={execute:async r=>{const command=await admitProductionNativeCommand(operation,{binding:r.binding,payload:r.payload,operationId:r.operationId,attestation:r.attestation},r.token,true,keys,identity,options.store);await provider.authorize(command);return provider.execute(command);}};}
 const facade=new ProductionFacade(identity,options.store,adapters,options.attestation.keyId,options.attestation.key),route=productionRouter(options.profile,facade,identity,hooks,options.peers);
 const handler=async(req:IncomingMessage,res:ServerResponse)=>{const url=new URL(req.url??'/','https://private.invalid');if(url.pathname==='/b2b/production/oauth/token'){try{const peer=productionPeer(req,options.peers);if(req.method!=='POST'||url.search)deny(400,'invalid_request');return productionJson(res,200,await identity.token(req.headers.authorization,await productionBody(req,true),peer));}catch(e){return productionFailure(res,e,true);}}
 if(url.pathname.startsWith('/internal/b2b/production/clients')&&options.administrationHandler)return options.administrationHandler(req,res);
 return route(req,res);};
 let server:Server|undefined;
 return {identity,catalogue,facade,hooks,handler,outbox:new ProductionNativeOutboxRelay(options.billing,hooks),
 async listen(port:number,host='127.0.0.1'){if(server)throw Error('PRODUCTION_CORE_ALREADY_LISTENING');if(!Number.isInteger(port)||port<0||port>65535)throw Error('PRODUCTION_PORT_REQUIRED');await options.store.transaction([],async tx=>{await tx.get('client','__production_storage_probe__');});
 server=createServer({ca:options.tls.ca,cert:options.tls.cert,key:options.tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},(req,res)=>{void handler(req,res).catch(e=>{if(!res.headersSent)productionFailure(res,e);else res.destroy();});});server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=50;server.listen(port,host);await once(server,'listening');return server.address() as AddressInfo;},
 async close(){if(!server)return;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));server=undefined;},
 tick:()=>hooks.tick(),
 };
}

