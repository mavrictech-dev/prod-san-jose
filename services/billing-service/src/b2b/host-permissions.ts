import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { b2bBindingsContain, validB2bBinding, validB2bPrincipal, type B2bBinding } from '@factuez/contracts/b2b-security';
import { currentGlobalClaims } from '@factuez/service-access/dist/b2b-owner-administration';
import type { PrivilegedHumanAuthority, Phase8LiveHumanIdentity } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type { B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPhase8Business } from './phase8-business/engine';
import type { BusinessAction, BusinessAuth, BusinessExecutor, BusinessInputMap, BusinessPermissionPort, BusinessStore } from './phase8-business/types';
import type { ContextRepository } from './context';
import { GuideEstablishments, type EstablishmentAdminAuthority, type EstablishmentAdministrator, type EstablishmentContext, type EstablishmentStore } from './guide-establishments';
import { billingAuthoritySchema, billingDigest, billingSnapshot, billingReceipt, billingPermissionFailure,
  type BillingAuthorityRequest, type BillingPermissionAction, type BillingAuthorityReceipt } from './host-permissions-wire';
import type { BillingAuthorityTransport } from './host-permissions-http';

type EstablishmentDependencies = {authority:PrivilegedHumanAuthority;liveIdentity:Phase8LiveHumanIdentity;identity:B2bIdentityPort};
type RequestAuthority = {operation:BillingPermissionAction;binding:B2bBinding;current():Promise<BillingAuthorityReceipt>;close():void};
type EstablishmentAuthority = {verify(token:string):Promise<EstablishmentAdministrator>;close():void};
type MasterCore<R,S>={read(token:string,companyId:number,context:EstablishmentContext):Promise<R>;replace(token:string,companyId:number,input:unknown,context:EstablishmentContext):Promise<S>};
const humanStamp = (c:any) => billingDigest({sub:c.sub,authVersion:c.authVersion,roles:c.roles,permissions:c.permissions,scope:c.scope});

/** Parent composes the SAME ports into the cores and wraps their entry points below.
 * ALS holds a revocable request capability; tokens live only in private closures, never in DTOs,
 * decisions, audit, persisted state or a principal-to-token cache. */
export class BillingHostPermissions {
  #transport: BillingAuthorityTransport; #enabled: boolean; #closed=false; #establishment?:EstablishmentDependencies;
  #business=new AsyncLocalStorage<RequestAuthority>();
  #establishments=new AsyncLocalStorage<EstablishmentAuthority>();
  constructor(transport: BillingAuthorityTransport, options: {enabled?:boolean;establishment?:EstablishmentDependencies} = {}) {
    this.#transport=transport;this.#enabled=options.enabled===true;this.#establishment=options.establishment;
  }
  #open(){if(!this.#enabled||this.#closed)return billingPermissionFailure();}
  async readiness(){
    this.#open();const r=billingSnapshot(await this.#transport.post({action:'STATUS'})) as any;
    if(!r||Object.keys(r).sort().join(',')!=='environment,schemaVersion,state'||r.schemaVersion!==billingAuthoritySchema||r.environment!=='BETA'||r.state!=='ASSEMBLED')return billingPermissionFailure();
    this.#open();return r;
  }
  #session(auth:BusinessAuth,operation:BillingPermissionAction,binding:B2bBinding):RequestAuthority {
    this.#open();const a=billingSnapshot(auth),b=billingSnapshot(binding);
    if(!a||Object.keys(a).sort().join(',')!=='kind,token'||a.kind!=='USER'||!validB2bBinding(b)||
        typeof a.token!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(a.token))return billingPermissionFailure(403);
    let token:string|null=a.token,stamp:string|null=null;const deadline=Date.now()+30000;
    const current=async()=>{
      this.#open();if(token===null||Date.now()>=deadline)return billingPermissionFailure(401);
      const q:BillingAuthorityRequest={action:'AUTHORIZE',requestId:randomUUID(),operation,binding:b};
      let receipt:unknown;try{receipt=await this.#transport.post(q,token);}catch{return billingPermissionFailure();}
      const r=billingReceipt(receipt,q);
      this.#open();if(token===null||Date.now()>=deadline||r.expiresAt<=Date.now())return billingPermissionFailure(401);
      if(stamp!==null&&stamp!==r.revision)return billingPermissionFailure(401);stamp=r.revision;
      return r;
    };
    return {operation,binding:b,current,close:()=>{token=null;}};
  }
  readonly businessPermissions:BusinessPermissionPort={authorizeCurrent:async request=>{
    this.#open();const scope=this.#business.getStore(),q=billingSnapshot(request);
    if(!scope||!q||Object.keys(q).sort().join(',')!=='action,binding,principal'||q.action!==scope.operation||billingDigest(q.binding)!==billingDigest(scope.binding)||
        !validB2bPrincipal(q.principal)||q.principal.kind!=='USER'||!b2bBindingsContain(q.principal.bindings,scope.binding))return billingPermissionFailure(403);
    const r=await scope.current();
    if(billingDigest(r.principal)!==billingDigest(q.principal))return billingPermissionFailure(401);
    return {allowed:true,revision:r.revision,...(r.administrator&&q.action.startsWith('PRODUCTS_')?{globalProductAuthority:{
      subjectId:r.administrator.sub,userAuthRevision:r.administrator.authVersion,scope:'GLOBAL' as const,
      stepUpVerified:true as const,permissions:r.administrator.permissions}}:{})};
  }};
  /** Core MUST use this.businessPermissions. Never expose the unwrapped core through HTTP. */
  wrapBusinessExecutor(core:BusinessExecutor):BusinessExecutor {
    return {execute:async <A extends BusinessAction>(auth:BusinessAuth,action:A,input:BusinessInputMap[A])=>{
      if(this.#business.getStore())return billingPermissionFailure(403);
      const a=billingSnapshot(auth),v=billingSnapshot(input);if(!v)return billingPermissionFailure(400);
      const session=this.#session(a,action,v.binding);
      try{return await this.#business.run(session,()=>core.execute(a,action,v));}finally{session.close();}
    }};
  }
  business(store:BusinessStore,identity:B2bIdentityPort,context:ContextRepository):BusinessExecutor {
    return this.wrapBusinessExecutor(new B2bPhase8Business(store,identity,context,this.businessPermissions));
  }
  readonly establishmentAdmin:EstablishmentAdminAuthority={verify:async token=>{
    this.#open();const scope=this.#establishments.getStore();if(!scope)return billingPermissionFailure(403);
    return scope.verify(token);
  }};
  #establishmentSession(tokenInput:string,binding:B2bBinding,payload:unknown):EstablishmentAuthority {
    this.#open();const deps=this.#establishment;
    if(!deps||typeof tokenInput!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(tokenInput))return billingPermissionFailure();
    const b=billingSnapshot(binding),payloadDigest=billingDigest(payload),deadline=Date.now()+30000;
    let token:string|null=tokenInput,stamp:string|null=null;
    return {close:()=>{token=null;},verify:async supplied=>{
      this.#open();if(token===null||supplied!==token||Date.now()>=deadline)return billingPermissionFailure(401);
      try{
        const before=billingSnapshot(await deps.identity.authenticate(token,['b2b:masters:manage'],'USER'));
        if(!validB2bPrincipal(before)||before.kind!=='USER'||!before.scopes.includes('b2b:masters:manage')||!b2bBindingsContain(before.bindings,b))return billingPermissionFailure(403);
        // Both are authority-only requests to the existing relay, never owner writes. Together
        // they prove setup.manage + series.manage for the exact master binding and payload digest.
        const setup=billingSnapshot(await deps.authority.authorize({token,kind:'USER',action:'MASTERS_READ',binding:b,payloadDigest}));
        const series=billingSnapshot(await deps.authority.authorize({token,kind:'USER',action:'SERIES_UPDATE',binding:b,payloadDigest,id:b.seriesId}));
        const live=billingSnapshot(await deps.liveIdentity.current(before.subjectId!));
        const after=billingSnapshot(await deps.identity.authenticate(token,['b2b:masters:manage'],'USER'));
        if(!currentGlobalClaims(live)||!currentGlobalClaims(setup.claims)||!currentGlobalClaims(series.claims)||
            live.sub!==before.subjectId||live.authVersion!==before.userAuthRevision||!['setup.manage','series.manage'].every(p=>live.permissions.includes(p as any))||
            humanStamp(live)!==humanStamp(setup.claims)||humanStamp(live)!==humanStamp(series.claims)||billingDigest(before)!==billingDigest(after)||
            [setup,series].some(d=>d.stepUpVerified!==true||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=Date.now()||d.expiresAt>Date.now()+30000||
              typeof d.policyRevision!=='string'||!/^[a-f0-9]{64}$/.test(d.policyRevision)))return billingPermissionFailure(403);
        const revision=billingDigest({principal:after,human:humanStamp(live),setup:setup.policyRevision,series:series.policyRevision,binding:b});
        if(stamp!==null&&stamp!==revision)return billingPermissionFailure(401);stamp=revision;
        this.#open();if(token===null||Date.now()>=deadline)return billingPermissionFailure(401);
        return {id:live.sub,authRevision:live.authVersion,stepUpVerified:true,scope:'GLOBAL',permissions:[...live.permissions]};
      }catch{return billingPermissionFailure();}
    }};
  }
  /** Core MUST use this.establishmentAdmin. Binding/company check closes verify(token)'s missing company argument. */
  wrapEstablishments<R,S>(core:MasterCore<R,S>,binding:B2bBinding){
    const b=billingSnapshot(binding);if(!validB2bBinding(b))return billingPermissionFailure(400);
    const execute=async <T>(token:string,companyId:number,payload:unknown,work:()=>Promise<T>)=>{
      if(this.#establishments.getStore()||companyId!==b.issuerId)return billingPermissionFailure(403);
      const session=this.#establishmentSession(token,b,payload);
      try{return await this.#establishments.run(session,work);}finally{session.close();}
    };
    return {
      read:(token:string,companyId:number,ctx:EstablishmentContext)=>{
        const context=billingSnapshot(ctx);return execute(token,companyId,{operation:'READ',companyId},()=>core.read(token,companyId,context));
      },
      replace:(token:string,companyId:number,input:unknown,ctx:EstablishmentContext)=>{
        const v=billingSnapshot(input),context=billingSnapshot(ctx);return execute(token,companyId,{operation:'REPLACE',companyId,input:v},()=>core.replace(token,companyId,v,context));
      },
    };
  }
  establishments(store:EstablishmentStore,binding:B2bBinding){return this.wrapEstablishments(new GuideEstablishments(store,this.establishmentAdmin),binding);}
  /** Fixed deployment-owned administrative anchors; never choose an arbitrary
   * first grant or reinterpret a note series as an 01/03 principal binding. */
  configuredEstablishments<R,S>(core:MasterCore<R,S>,bindings:readonly B2bBinding[]){
    const selected=billingSnapshot(bindings);
    if(!Array.isArray(selected)||!selected.length||selected.length>100||!selected.every(validB2bBinding)||new Set(selected.map(b=>b.issuerId)).size!==selected.length)return billingPermissionFailure(400);
    const boundary=(companyId:number)=>{
      this.#open();const binding=selected.find(b=>b.issuerId===companyId);if(!binding)return billingPermissionFailure(403);
      return this.wrapEstablishments(core,binding);
    };
    return {
      read:(token:string,companyId:number,context:EstablishmentContext)=>boundary(companyId).read(token,companyId,context),
      replace:(token:string,companyId:number,input:unknown,context:EstablishmentContext)=>boundary(companyId).replace(token,companyId,input,context),
    };
  }
  close(){this.#closed=true;}
  toJSON(){return {service:'BillingHostPermissions',contents:'PRIVATE'};}
  [inspect.custom](){return this.toJSON();}
}

