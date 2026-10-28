import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { B2bSecurityError, B2bPhase8Scopes, b2bBindingKey, type B2bBinding, type B2bPrincipal } from '../../packages/contracts/src/b2b-security';
import { B2bPhase8Business, type BusinessAction, type BusinessCustomer, type BusinessOperation, type BusinessPermissionDecision, type BusinessPermissionPort, type BusinessProduct, type BusinessShift, type BusinessMovement, type BusinessStore, type BusinessTransaction } from '../../services/billing-service/src/b2b/phase8-business';
import { ExactDecimal } from '../../services/billing-service/src/b2b/phase8-business/validation';
const binding=():B2bBinding=>({issuerId:1,issuerRuc:'00000000001',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01',environment:'BETA'});
export const customer=()=>({identityType:'6' as const,identityNumber:'00000000011',legalName:'CLIENTE SINTETICO',address:null,email:null,active:true});
export const product=()=>({sku:'SYNTHETIC-1',description:'PRODUCTO SINTETICO',category:'PRUEBA',unitCode:'NIU',taxAffectationCode:'10',defaultUnitPrice:'0.100001',active:true});
export const key=()=>randomUUID(),error=(code:string,status?:number)=>({code,...(status?{status}:{})});
type State={customers:Map<string,BusinessCustomer>;products:Map<string,BusinessProduct>;shifts:Map<string,BusinessShift>;movements:BusinessMovement[];operations:BusinessOperation[]};
export const empty=():State=>({customers:new Map(),products:new Map(),shifts:new Map(),movements:[],operations:[]});
const sameIssuer=(a:{issuerId:number;issuerRuc:string},b:{issuerId:number;issuerRuc:string})=>a.issuerId===b.issuerId&&a.issuerRuc===b.issuerRuc;
const samePoint=(a:B2bBinding,b:B2bBinding)=>sameIssuer(a,b)&&a.environment===b.environment&&a.branchId===b.branchId&&a.pointId===b.pointId;
/** Test fixture only, never a production persistence fallback. */
export class MemoryBusinessStore implements BusinessStore {
 state=empty();closed=false;failAudit=false;failMovement=false;private tail:Promise<unknown>=Promise.resolve();
 transaction<T>(_locks:readonly string[],work:(tx:BusinessTransaction)=>Promise<T>):Promise<T>{
  const task=this.tail.then(async()=>{
   if(this.closed)throw new B2bSecurityError(503,'BUSINESS_STORE_UNAVAILABLE');
   const s=structuredClone(this.state),copy=<T>(v:T):T=>structuredClone(v);
   const rows=<T extends {id:string}>(r:T[],q:{limit:number;after:string|null;q:string},search:(v:T)=>string)=>copy(r.filter(v=>(q.after===null||v.id>q.after)&&search(v).toLowerCase().includes(q.q.toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,q.limit));
   const cu=(r:BusinessCustomer)=>{if([...s.customers.values()].some(c=>c.id!==r.id&&sameIssuer(c,r)&&c.identityType===r.identityType&&c.identityNumber===r.identityNumber))throw new B2bSecurityError(409,'CUSTOMER_IDENTITY_CONFLICT');};
   const pu=(r:BusinessProduct)=>{if([...s.products.values()].some(p=>p.id!==r.id&&p.sku===r.sku))throw new B2bSecurityError(409,'PRODUCT_SKU_CONFLICT');};
   const tx:BusinessTransaction={
    prior:async(a,k)=>copy(s.operations.find(o=>o.actorKey===a&&o.keyHash===k)??null),append:async o=>{if(this.failAudit)throw Error('synthetic audit failure');s.operations.push(copy(o));},
    customers:async(scope,q)=>rows([...s.customers.values()].filter(c=>sameIssuer(c,scope)),q,c=>c.legalName+' '+c.identityNumber),
    customer:async(scope,id)=>copy(s.customers.has(id)&&sameIssuer(s.customers.get(id)!,scope)?s.customers.get(id)!:null),
    createCustomer:async r=>{cu(r);s.customers.set(r.id,copy(r));},saveCustomer:async(r,e)=>{if(s.customers.get(r.id)?.revision!==e)throw new B2bSecurityError(412,'REVISION_CONFLICT');cu(r);s.customers.set(r.id,copy(r));},
    products:async q=>rows([...s.products.values()],q,p=>p.sku+' '+p.description+' '+p.category),product:async id=>copy(s.products.get(id)??null),
    createProduct:async r=>{pu(r);s.products.set(r.id,copy(r));},saveProduct:async(r,e)=>{if(s.products.get(r.id)?.revision!==e)throw new B2bSecurityError(412,'REVISION_CONFLICT');pu(r);s.products.set(r.id,copy(r));},
    shifts:async(b,a,q)=>rows([...s.shifts.values()].filter(s=>s.actorKey===a&&b2bBindingKey(s.binding)===b2bBindingKey(b)),q,s=>s.id+' '+s.state),
    shift:async(b,a,id)=>{const r=s.shifts.get(id);return copy(r&&r.actorKey===a&&b2bBindingKey(r.binding)===b2bBindingKey(b)?r:null);},
    createShift:async r=>{if([...s.shifts.values()].some(v=>v.state==='OPEN'&&samePoint(v.binding,r.binding)))throw new B2bSecurityError(409,'SHIFT_ALREADY_OPEN');s.shifts.set(r.id,copy(r));},
    saveShift:async(r,e)=>{if(s.shifts.get(r.id)?.revision!==e||s.shifts.get(r.id)?.state!=='OPEN')throw new B2bSecurityError(412,'REVISION_CONFLICT');s.shifts.set(r.id,copy(r));},
    movement:async r=>{if(this.failMovement)throw Error('synthetic movement failure');s.movements.push(copy(r));},
    movementBalance:async id=>s.movements.filter(m=>m.shiftId===id).reduce((sum,m)=>m.kind==='OPEN'||m.kind==='IN'?sum.plus(m.amount):m.kind==='OUT'?sum.minus(m.amount):sum,new ExactDecimal(0)).toFixed(2),
    summary:async(scope,b,a)=>{const shifts=[...s.shifts.values()].filter(v=>v.actorKey===a&&b2bBindingKey(v.binding)===b2bBindingKey(b));return {
     customers:String([...s.customers.values()].filter(c=>sameIssuer(c,scope)).length),activeCustomers:String([...s.customers.values()].filter(c=>sameIssuer(c,scope)&&c.active).length),sharedProducts:String(s.products.size),actorPointShifts:String(shifts.length),actorPointOpenShifts:String(shifts.filter(s=>s.state==='OPEN').length),
     cash:[...new Set(shifts.map(s=>s.currency))].sort().map(currency=>{const ids=shifts.filter(s=>s.currency===currency).map(s=>s.id),movements=s.movements.filter(m=>ids.includes(m.shiftId));return {currency,incoming:movements.filter(m=>m.kind==='IN').reduce((s,m)=>s.plus(m.amount),new ExactDecimal(0)).toFixed(2),outgoing:movements.filter(m=>m.kind==='OUT').reduce((s,m)=>s.plus(m.amount),new ExactDecimal(0)).toFixed(2)};})};}
   };
   const result=await work(tx);this.state=s;return result;
  });this.tail=task.catch(()=>{});return task;
 }
 async close(){this.closed=true;}
}
export function fixture(store:BusinessStore=new MemoryBusinessStore()){
 const b=binding(),other={...binding(),issuerId:2,issuerRuc:'00000000002'};
 let principal:B2bPrincipal={kind:'USER',clientId:randomUUID(),revision:1,subjectId:randomUUID(),userAuthRevision:1,scopes:[...B2bPhase8Scopes],bindings:[b,other],environment:'BETA'};
 let allowed=true,global=true,stepUp=true,servicePolicy=true,contextActive=true,permissionRevision='1',calls=0;
 const identity={authenticate:vi.fn(async(token:string,required:readonly string[],kind:'USER'|'SERVICE')=>{
  if(token!=='synthetic-token'||principal.kind!==kind||required.some(s=>!principal.scopes.some(v=>v===s)))throw new B2bSecurityError(401,'INVALID_PRINCIPAL');return structuredClone(principal);
 })};
 const permissions:BusinessPermissionPort={authorizeCurrent:vi.fn(async()=>{calls++;if(!allowed)throw new B2bSecurityError(403,'OWNER_PERMISSION_DENIED');
  const d:BusinessPermissionDecision={allowed:true,revision:permissionRevision};if(principal.kind==='SERVICE'&&servicePolicy)d.servicePolicyId='synthetic-explicit-owner-policy-v1';
  if(principal.kind==='USER'&&global&&stepUp)d.globalProductAuthority={subjectId:principal.subjectId!,userAuthRevision:principal.userAuthRevision!,scope:'GLOBAL',stepUpVerified:true,permissions:['product.manage']};return d;
 })};
 const context={resolve:vi.fn(async()=>contextActive?{binding:b}:null)},engine=new B2bPhase8Business(store,identity,context,permissions,()=>1792800000000);
 const auth=()=>({token:'synthetic-token',kind:principal.kind});
 const execute=(action:BusinessAction,input:Record<string,unknown>={})=>engine.execute(auth(),action,{binding:b,...input} as never);
 const createCustomer=(extra:Record<string,unknown>={})=>execute('CUSTOMERS_CREATE',{idempotencyKey:key(),body:customer(),...extra});
 const createProduct=(extra:Record<string,unknown>={})=>execute('PRODUCTS_CREATE',{idempotencyKey:key(),body:product(),...extra});
 const open=(extra:Record<string,unknown>={})=>execute('SHIFTS_OPEN',{idempotencyKey:key(),openingAmount:'0.10',currency:'PEN',...extra});
 return {b,other,store,engine,core:engine,identity,context,permissions,auth,execute,createCustomer,createProduct,open,
  get principal(){return principal;},set principal(p:B2bPrincipal){principal=p;},set allowed(v:boolean){allowed=v;},set global(v:boolean){global=v;},set stepUp(v:boolean){stepUp=v;},set servicePolicy(v:boolean){servicePolicy=v;},set contextActive(v:boolean){contextActive=v;},set permissionRevision(v:string){permissionRevision=v;},get calls(){return calls;}};
}

export { fixture as harness, fixture as businessFixture };
