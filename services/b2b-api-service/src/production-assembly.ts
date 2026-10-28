import {Inject,Injectable,type OnApplicationBootstrap,type OnApplicationShutdown,type Provider,type InjectionToken} from '@nestjs/common';
import {createProductionCoreHost,type ProductionCoreHostOptions} from './production-core-host';
import {type ProductionNativeCatalogue,type ProductionBillingSql,type ProductionIssuePort,type ProductionNotesPort,type ProductionGuidesPort} from './production-native-billing';
import type {ProductionStore} from '@factuez/service-access/dist/b2b-production-contract';
import type {ProductionCallbackTransport} from '@factuez/service-access/dist/b2b-production-callback';
export const PRODUCTION_B2B_CORE=Symbol('FactuEz PRODUCTION B2B core host');
const SETTINGS=Symbol('FactuEz PRODUCTION B2B listener settings');
export interface ProductionAssemblySettings {port:number;host?:string;/** Explicit opt-in. Keep false for development/no-send verification. */dispatchEnabled?:boolean;intervalMs?:number}
@Injectable()
export class ProductionB2bCoreLifecycle implements OnApplicationBootstrap,OnApplicationShutdown {
 private timer?:ReturnType<typeof setInterval>;private active?:Promise<unknown>;private stopping=false;
 public status:{listener:'STOPPED'|'LISTENING';worker:'DISABLED'|'IDLE'|'RUNNING'|'FAILED';lastError?:string}={listener:'STOPPED',worker:'DISABLED'};
 constructor(@Inject(PRODUCTION_B2B_CORE)private readonly core:ReturnType<typeof createProductionCoreHost>,@Inject(SETTINGS)private readonly settings:ProductionAssemblySettings){}
 async onApplicationBootstrap(){await this.core.listen(this.settings.port,this.settings.host??'127.0.0.1');this.status.listener='LISTENING';if(this.settings.dispatchEnabled===true){this.status.worker='IDLE';this.timer=setInterval(()=>{if(this.stopping||this.active)return;this.status.worker='RUNNING';const pending=this.core.tick();this.active=pending;void pending.then(()=>{this.status.worker='IDLE';delete this.status.lastError;},()=>{this.status.worker='FAILED';this.status.lastError='PRODUCTION_WEBHOOK_WORKER_FAILED';}).finally(()=>{this.active=undefined;});},Math.max(1000,this.settings.intervalMs??1000));this.timer.unref();}}
 async onApplicationShutdown(){this.stopping=true;clearInterval(this.timer);await this.active?.catch(()=>{});await this.core.close();this.status.listener='STOPPED';}
}
export interface ProductionAssemblyConfig {
 settings:ProductionAssemblySettings;
 tokens:{billing:InjectionToken;store:InjectionToken;issue:InjectionToken;notes:InjectionToken;guides:InjectionToken;callbacks:InjectionToken;identityAdmin:InjectionToken};
 /** Main injects its explicit PRODUCTION admin authority and constructs ProductionIdentity. */
 createIdentity:(store:ProductionStore,catalogue:ProductionNativeCatalogue,admin:unknown)=>ReturnType<ProductionCoreHostOptions['identity']>;
 host:Omit<ProductionCoreHostOptions,'store'|'billing'|'native'|'callbacks'|'identity'>;
}
/** Add this provider array to the SAME core module as native owner providers.
 * No nested module provider visibility assumptions; no imports of main/AppModule or BETA bootstraps. */
export function productionB2bCoreProviders(config:ProductionAssemblyConfig):Provider[]{return [
 {provide:SETTINGS,useValue:config.settings},
 {provide:PRODUCTION_B2B_CORE,inject:[config.tokens.billing,config.tokens.store,config.tokens.issue,config.tokens.notes,config.tokens.guides,config.tokens.callbacks,config.tokens.identityAdmin],useFactory:(billing:ProductionBillingSql,store:ProductionStore,issue:ProductionIssuePort,notes:ProductionNotesPort,guides:ProductionGuidesPort,callbacks:ProductionCallbackTransport,admin:unknown)=>createProductionCoreHost({...config.host,billing,store,native:{issue,notes,guides},callbacks,identity:catalogue=>config.createIdentity(store,catalogue,admin)})},
 ProductionB2bCoreLifecycle,
 ];}
