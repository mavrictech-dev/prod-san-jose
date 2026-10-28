import {Catch,Controller,HttpException,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule,type ArgumentsHost} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from './b2b';
import {adminSnapshot,phase8AdminPolicy,type Phase8AdminAction,type Phase8AdminAccess} from './b2b-phase8-admin-wire';
export interface Phase8AdminOwnerExecutor{execute(access:Phase8AdminAccess,action:Phase8AdminAction,input:unknown):Promise<unknown>}
const CORE=Symbol('Privileged owner'),PEERS=Symbol('Privileged peers'),ACTIONS=Symbol('Owner action map');
@Catch()export class Phase8AdminOwnerFilter{catch(e:unknown,h:ArgumentsHost){const n=e instanceof B2bSecurityError?e.status:e instanceof HttpException?e.getStatus():503,status=[400,401,403,404,409,413,422,429].includes(n)?n:503;const s=h.switchToHttp().getResponse();s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');return s.status(status).json({code:status===503?'ADMIN_OWNER_UNAVAILABLE':'ADMIN_REQUEST_DENIED'});}}
@Controller('internal/b2b')
@UseFilters(Phase8AdminOwnerFilter)
export class Phase8AdminOwnerController{
 constructor(@Inject(CORE)private readonly core:Phase8AdminOwnerExecutor,@Inject(PEERS)private readonly peers:readonly string[],@Inject(ACTIONS)private readonly actions:readonly Phase8AdminAction[]){}
 @Post('owner-admin')async execute(@Req()r:any,@Res()s:any){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,b:any=adminSnapshot(r.body);
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a))throw new B2bSecurityError(401,'INVALID_TOKEN');
  if(r.url.includes('?')||!b||Object.keys(b).sort().join(',')!=='action,input,kind'||b.kind!=='USER'||!this.actions.includes(b.action))throw new B2bSecurityError(403,'ADMIN_REQUEST_DENIED');
  return s.status(200).json(await this.core.execute({token:a.slice(7),kind:'USER'},b.action,b.input));
 }
}
@Module({})
export class Phase8AdminOwnerModule{static isolated(core:Phase8AdminOwnerExecutor,actions:readonly Phase8AdminAction[],peers:readonly string[]):DynamicModule{
 if(!core||typeof core.execute!=='function'||!actions.length||new Set(actions).size!==actions.length||actions.some(a=>!Object.hasOwn(phase8AdminPolicy,a))||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_PRIVILEGED_OWNER_REQUIRED');
 return {module:Phase8AdminOwnerModule,controllers:[Phase8AdminOwnerController],providers:[Phase8AdminOwnerFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]},{provide:ACTIONS,useValue:[...actions]}]};}}
