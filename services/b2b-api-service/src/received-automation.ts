import {Controller,Get,Inject,Module,Param,Patch,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScopeQuery,receivedScope,receivedAnchor,receivedFail,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import {B2bReceivedHttpErrorFilter} from './received';
type Access={token:string;kind:'SERVICE'|'USER'};type Action='CONFIG_READ'|'CONFIG_SAVE'|'SYNC_CREATE'|'SYNC_READ';
export interface ReceptionAutomationPort{execute(access:Access,action:Action,input:any):Promise<unknown>}
export class HttpReceptionAutomation implements ReceptionAutomationPort{
 constructor(private readonly http:Pick<B2bPrivateHttp,'post'>){}
 execute(access:Access,action:Action,input:unknown){return this.http.post('/internal/b2b/received-automation',{kind:access.kind,action,input},access.token);}
}
export class B2bReceivedAutomation{
 #automatic:boolean;
 constructor(private readonly identity:B2bIdentityPort,private readonly owner:ReceptionAutomationPort,options:{automaticReceivedApprovals?:boolean}={}){
  if(options.automaticReceivedApprovals!==undefined&&typeof options.automaticReceivedApprovals!=='boolean')throw Error('INVALID_RECEIVED_APPROVAL_OPTION');this.#automatic=options.automaticReceivedApprovals===true;
 }
 async execute(access:Access,action:Action,input:any){
  const v:any=correctionEvidenceFreeze(input),scope=receivedScope(v?.scope),required=action.startsWith('CONFIG_')?'b2b:received:configure':'b2b:received:sync';
  if(!['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'].includes(action))receivedFail();
  const frame=new B2bOwnerReadFrame(this.identity,access.kind),fresh=async()=>receivedAnchor(await frame.principal(access.token,[required]),scope);await fresh();
  // The token marker is private facade-to-owner context, never a caller-supplied handle.
  if(typeof v.payload?.stepUpHandle==='string'&&v.payload.stepUpHandle.startsWith('oidc-stepup.'))receivedFail(403,'STEP_UP_REQUIRED');
  let ownerInput=v;
  if(this.#automatic&&access.kind==='USER'&&v.payload&&typeof v.payload==='object'&&!Array.isArray(v.payload)&&!Object.hasOwn(v.payload,'stepUpHandle')){
   const marker='oidc-stepup.'+access.token;if(marker.length>8192)receivedFail();ownerInput={...v,payload:{...v.payload,stepUpHandle:marker}};
  }
  const r:any=correctionEvidenceFreeze(await this.owner.execute(access,action,ownerInput));
  if(!r||hash(receivedScope(r.scope))!==hash(scope)||r.runtimeEnabled!==false||r.fiscalAcceptance!=='NOT_VERIFIED')receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  if(action.startsWith('CONFIG_')){
   if(Object.keys(r).sort().join(',')!=='credentialPresence,fiscalAcceptance,networkProfile,revision,runtimeEnabled,scope,settings,state,updatedAt'||
    !r.credentialPresence||Object.keys(r.credentialPresence).sort().join(',')!=='mailPassword,sireClientSecret,solPassword'||Object.values(r.credentialPresence).some(v=>typeof v!=='boolean'))receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  }else if(action==='SYNC_CREATE'){
   if(Object.keys(r).sort().join(',')!=='fiscalAcceptance,items,mode,networkProfile,runtimeEnabled,scope'||!Array.isArray(r.items)||r.items.length>2||r.items.some((j:any)=>j.dispatch!=='NOT_DISPATCHED'))receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  }else if(Object.keys(r).sort().join(',')!=='fiscalAcceptance,run,runtimeEnabled,scope')receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  await fresh();return {schemaVersion:'factuez.b2b.received-automation.v1',action,...r};
 }
}
const CORE=Symbol('Reception automation'),PEERS=Symbol('Automation peers');
@Controller('b2b/v1')
@UseFilters(B2bReceivedHttpErrorFilter)
export class B2bReceivedAutomationController{
 constructor(@Inject(CORE)private readonly core:B2bReceivedAutomation,@Inject(PEERS)private readonly peers:readonly string[]){}
 private context(r:any,s:any,issuerId?:string){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,k=r.headers['x-factuez-actor-kind'];
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||!['SERVICE','USER'].includes(k))receivedFail(401,'INVALID_TOKEN');
  const q=new URLSearchParams((r.originalUrl??r.url).split('?').slice(1).join('?')),keys=[...q.keys()];if(keys.length!==4||new Set(keys).size!==4||keys.some(n=>!['environment','companyId','recipientRuc','branchId'].includes(n)))receivedFail();
  const scope=receivedScopeQuery(Object.fromEntries(q));if(issuerId!==undefined&&String(scope.companyId)!==issuerId)receivedFail(404,'RESOURCE_NOT_FOUND');
  const proof=r.headers['x-factuez-step-up'];if(proof!==undefined&&(typeof proof!=='string'||!/^[-A-Za-z0-9._~]{1,8192}$/.test(proof)))receivedFail();
  const body:any=correctionEvidenceFreeze(r.body??{});if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(n=>['stepUpHandle','runId','scope','key'].includes(n)))receivedFail();
  return {access:{token:a.slice(7),kind:k as Access['kind']},scope,body,proof,key:r.headers['idempotency-key']};
 }
 private input(r:ReturnType<B2bReceivedAutomationController['context']>,write=false,payload=r.body){return {scope:r.scope,...(write?{key:r.key}:{}),payload:{...payload,...(r.proof?{stepUpHandle:r.proof}:{})}};}
 @Get('admin/received-connectors/:issuerId')read(@Req()r:any,@Res({passthrough:true})s:any,@Param('issuerId')id:string){const c=this.context(r,s,id);if(r.body!==undefined)receivedFail();return this.core.execute(c.access,'CONFIG_READ',this.input(c));}
 @Patch('admin/received-connectors/:issuerId')save(@Req()r:any,@Res({passthrough:true})s:any,@Param('issuerId')id:string){const c=this.context(r,s,id);return this.core.execute(c.access,'CONFIG_SAVE',this.input(c,true));}
 @Post('received-sync-jobs')sync(@Req()r:any,@Res({passthrough:true})s:any){const c=this.context(r,s);return this.core.execute(c.access,'SYNC_CREATE',this.input(c,true));}
 @Get('received-sync-jobs/:id')status(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){const c=this.context(r,s);if(r.body!==undefined)receivedFail();return this.core.execute(c.access,'SYNC_READ',this.input(c,false,{runId:id}));}
}
@Module({})
export class B2bReceivedAutomationModule{static isolated(core:B2bReceivedAutomation,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_AUTOMATION_OWNER_REQUIRED');return {module:B2bReceivedAutomationModule,controllers:[B2bReceivedAutomationController],providers:[B2bReceivedHttpErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
