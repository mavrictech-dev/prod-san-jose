import {Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {b2bPrivatePeer} from './b2b';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
export const b2bOwnerRuntimeCapabilities={
 identity:['IDENTITY','APPLICATION_ADMIN','PRIVILEGED_ADMIN','CORRECTION_AUTHORITY','GUIDE_AUTHORITY','WEBHOOK_AUTHORITY'],
 billing:['READ','DRAFTS','COMMERCIAL','CORRECTIONS','GUIDES','CARRIER','BATCHES','BUSINESS','REPORTS','PRIVILEGED_ADMIN'],
 fiscal:['READ','GUIDE_ARTIFACTS','BATCH_ARTIFACTS','CORRECTION_EVIDENCE','PRIVILEGED_ADMIN'],
 webhooks:['SUBSCRIPTIONS','DELIVERIES','INGEST'],received:['READ','COMMANDS','AUTOMATION'],
 history:['READ'],exports:['EXTRACTION','CHANGES'],mailer:['EMAIL','PRIVILEGED_ADMIN'],
} as const;
export type B2bRuntimeOwner=keyof typeof b2bOwnerRuntimeCapabilities;
const CORE=Symbol('B2B runtime readiness'),PEERS=Symbol('B2B runtime peers');
export class B2bOwnerRuntimeStatus {
 readonly bootId=randomUUID();
 constructor(readonly owner:B2bRuntimeOwner,readonly deploymentId:string,readonly capabilities:readonly string[],private readonly check:()=>Promise<void>){
  if(!Object.hasOwn(b2bOwnerRuntimeCapabilities,owner)||!/^[a-f0-9-]{36}$/.test(deploymentId)||!Array.isArray(capabilities)||!capabilities.length||
   new Set(capabilities).size!==capabilities.length||capabilities.some(c=>!(b2bOwnerRuntimeCapabilities[owner] as readonly string[]).includes(c))||typeof check!=='function')throw Error('EXPLICIT_OWNER_RUNTIME_STATUS_REQUIRED');
 }
 async inspect(){await this.check();return {schemaVersion:'factuez.b2b.owner-runtime.v1',environment:'BETA',owner:this.owner,deploymentId:this.deploymentId,bootId:this.bootId,
  capabilities:[...this.capabilities].sort(),state:'ASSEMBLED_AND_STORAGE_CHECKED',fiscalActivation:false};}
}
@Catch()
class RuntimeStatusFilter {
 catch(error:unknown,host:ArgumentsHost){const response=host.switchToHttp().getResponse(),status=error instanceof B2bSecurityError?error.status:503;
  response.setHeader('Cache-Control','private, no-store');response.status(status).json({code:status===503?'OWNER_RUNTIME_NOT_READY':'OWNER_RUNTIME_REQUEST_DENIED'});}
}
@Controller('internal/b2b')
@UseFilters(RuntimeStatusFilter)
class RuntimeStatusController {
 constructor(@Inject(CORE)private readonly core:B2bOwnerRuntimeStatus,@Inject(PEERS)private readonly peers:readonly string[]){}
 @Post('runtime-status')async inspect(@Req()req:any,@Res()res:any){
  b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');
  const names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase());
  if(req.url.includes('?')||req.headers.authorization||new Set(names).size!==names.length||!req.body||Object.keys(req.body).length||Object.getPrototypeOf(req.body)!==Object.prototype)
   throw new B2bSecurityError(400,'INVALID_RUNTIME_PROBE');
  return res.status(200).json(await this.core.inspect());
 }
}
/** Install alongside actual owner modules only AFTER their construction. The
 * storage callback checks schema readiness, never migrates or grants access. */
@Module({})
export class B2bOwnerRuntimeStatusModule {
 static isolated(core:B2bOwnerRuntimeStatus,peers:readonly string[]):DynamicModule {
  if(!(core instanceof B2bOwnerRuntimeStatus)||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw Error('EXPLICIT_RUNTIME_STATUS_PEERS_REQUIRED');
  return {module:B2bOwnerRuntimeStatusModule,controllers:[RuntimeStatusController],providers:[RuntimeStatusFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};
 }
}
