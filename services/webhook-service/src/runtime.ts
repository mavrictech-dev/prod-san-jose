import type {ConnectionOptions} from 'bullmq';
import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {B2bOwnerDrain} from '@factuez/service-access/dist/b2b-owner-drain';
import {B2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule,b2bOwnerRuntimeCapabilities} from '@factuez/service-access/dist/b2b-runtime-status';
import {HookVault} from './crypto';
import {Webhooks} from './core';
import {PostgresHookStore,type HookPool} from './store';
import type {CallbackTransport,DeliveryAuthority} from './model';
import {createWebhookApplication} from './application';
import {WebhookWorker} from './worker';
import type {WebhookPeers} from './http';

export interface WebhookRuntimeOptions {
 enabled?:boolean;deploymentId:string;instanceId:string;
 database:HookPool&{end():Promise<void>};identity:B2bIdentityPort;authority:DeliveryAuthority;callbacks:CallbackTransport;vault:HookVault;
 peers:WebhookPeers;operatorPeers:string[];tls:{ca:Buffer;cert:Buffer;key:Buffer};
 host:'127.0.0.1'|'0.0.0.0';port:number;maintenancePort:number;
 dispatchEnabled:boolean;redis?:ConnectionOptions;
}
/** Concrete PostgreSQL webhook owner. No schemas, grants, subscriptions, callback
 * verification, emission or listener activation during disabled construction. */
export async function createWebhookOwnerRuntime(options:WebhookRuntimeOptions){
 if(options.enabled!==true)return null;
 if(!options.database||typeof options.database.end!=='function'||typeof options.dispatchEnabled!=='boolean'||options.port===options.maintenancePort||
  !Number.isInteger(options.port)||options.port<1024||options.port>65535||!Number.isInteger(options.maintenancePort)||options.maintenancePort<1024||options.maintenancePort>65535||
  options.operatorPeers.some(p=>options.peers.facade.includes(p)||options.peers.billingPublisher.includes(p)))throw Error('WEBHOOK_OWNER_RUNTIME_CONFIG_REQUIRED');
 const store=await PostgresHookStore.isolated(options.database),core=new Webhooks(store,options.identity,options.authority,options.callbacks,options.vault),worker=new WebhookWorker(core);
 const status=new B2bOwnerRuntimeStatus('webhooks',options.deploymentId,b2bOwnerRuntimeCapabilities.webhooks,async()=>{await PostgresHookStore.isolated(options.database);});
 const app=await createWebhookApplication(core,options.peers,options.tls,B2bOwnerRuntimeStatusModule.isolated(status,options.peers.facade));
 const gate=new B2bOwnerDrain({enabled:true});gate.install(app);
 const wait=async(which:'COMMANDS'|'MUTATIONS'|'ALL')=>{while((await gate.drain(which,30000)).state!=='DRAINED'){/* Explicit unfinished work; never force close. */}};
 const maintenance=new B2bMaintenanceNode({enabled:true,deploymentId:options.deploymentId,instance:{service:'WEBHOOKS',instanceId:options.instanceId,bootId:status.bootId},hooks:{
  ADMISSION:async()=>{gate.pauseCommands();await wait('COMMANDS');},PRODUCERS:async()=>{},
  WORKERS:async()=>{await worker.close();await wait('MUTATIONS');},
  STORAGE:async()=>{gate.closeAdmission();await wait('ALL');await app.close();await options.database.end();},
 }});
 let started=false;
 return {app,core,worker,status,gate,maintenance,
  async start(){
   if(started||maintenance.snapshot().state!=='READY')throw Error('WEBHOOK_RUNTIME_ALREADY_STARTED');started=true;
   try{
    await maintenance.listen({host:options.host,port:options.maintenancePort,tls:options.tls,operatorPeers:options.operatorPeers});
    await app.listen(options.port,options.host);if(options.dispatchEnabled)worker.start(options.redis);
   }catch{await worker.close();await app.close();await maintenance.closeListener();await options.database.end();throw Error('WEBHOOK_OWNER_STARTUP_FAILED');}
  },
 };
}
