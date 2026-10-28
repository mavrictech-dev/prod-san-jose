import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { BillingHostPermissions } from '../services/billing-service/src/b2b/host-permissions';
import { billingAuthoritySchema, billingDigest, billingAdminAction, billingPermissionPolicy } from '../services/billing-service/src/b2b/host-permissions-wire';
import { fixture, customer, product, MemoryBusinessStore } from './helpers/b2b-phase8-business.fixture';

// These are isolated contract/ALS tests. The relay integration lives in the sibling
// spec; this fake transport is NOT a deployed Identity implementation.
function setup(){
  const f=fixture(),state={revision:'a'.repeat(64),permission:true,stepUp:true,extra:false,requests:[] as any[]};
  const token='synthetic-oidc-request-000001';
  const identity={authenticate:vi.fn(async()=>structuredClone(f.principal))};
  const transport={post:vi.fn(async(q:any,bearer?:string):Promise<any>=>{
    state.requests.push({request:structuredClone(q),bearer});
    if(!state.permission)throw Error('PRIVATE_PROVIDER_DIAGNOSTIC');
    const permissions=['document.view','document.issue','report.view','shift.open','shift.close','product.manage'];
    const now=Math.floor(Date.now()/1000),admin=billingAdminAction(q.operation);
    return {schemaVersion:billingAuthoritySchema,requestSha256:billingDigest(q),principal:structuredClone(f.principal),permissions,
      administrator:admin?{sub:f.principal.subjectId,username:'SYNTHETIC',roles:['ADMIN'],permissions,scope:{kind:'GLOBAL'},
        authVersion:f.principal.userAuthRevision,iss:'https://oidc.synthetic.invalid',aud:'factuez-b2b-v1',iat:now,exp:now+30}:null,
      stepUpVerified:admin?state.stepUp:false,revision:state.revision,expiresAt:Date.now()+29000,...(state.extra?{approve:true}:{})};
  })};
  const host=new BillingHostPermissions(transport,{enabled:true}),engine=host.business(f.store,identity,f.context),auth={token,kind:'USER' as const};
  const execute=(action:any,fields:any={})=>engine.execute(auth,action,{binding:f.b,...fields} as any);
  return {f,state,identity,transport,host,engine,auth,execute};
}
describe('Billing current permission ports: revocable ALS authority on exact request',()=>{
  it('writes products with a current global human proof, preserving core transactions and audit',async()=>{
    const x=setup();await x.execute('PRODUCTS_CREATE',{idempotencyKey:randomUUID(),body:product()});
    const state=(x.f.store as MemoryBusinessStore).state;
    expect(state.products.size).toBe(1);expect(state.operations[0].permissionRevision).toBe(x.state.revision);
    expect(x.transport.post).toHaveBeenCalledTimes(3);expect(x.state.requests.every(r=>r.bearer===x.auth.token)).toBe(true);
    expect(JSON.stringify(state)).not.toContain(x.auth.token);
  });
  it.each(Object.keys(billingPermissionPolicy).filter(k=>k!=='ESTABLISHMENTS'&&!['CUSTOMERS_DETAIL','CUSTOMERS_UPDATE','PRODUCTS_UPDATE','SHIFTS_CLOSE','SHIFTS_CASH'].includes(k)))('resolves %s without converting scopes into roles',async action=>{
    const x=setup();const fields=action==='CUSTOMERS_CREATE'?{idempotencyKey:randomUUID(),body:customer()}:action==='PRODUCTS_CREATE'?{idempotencyKey:randomUUID(),body:product()}:
      action==='SHIFTS_OPEN'?{idempotencyKey:randomUUID(),openingAmount:'0.00',currency:'PEN'}:{};
    await x.execute(action,fields);expect(x.transport.post).toHaveBeenCalledTimes(3);
  });
  it.each(['stepUp','extra','permissions','principal','request','expiration'])('rejects a malformed or stale %s proof before persistence',async defect=>{
    const x=setup(),original=x.transport.post.getMockImplementation()!;
    x.transport.post.mockImplementation(async(q,b)=>{
      const r=await original(q,b);
      if(defect==='stepUp')r.stepUpVerified=false;if(defect==='extra')r.approve=true;if(defect==='permissions')r.permissions=[];
      if(defect==='principal')r.principal.userAuthRevision++;if(defect==='request')r.requestSha256='b'.repeat(64);if(defect==='expiration')r.expiresAt=0;
      return r;
    });
    await expect(x.execute('PRODUCTS_CREATE',{idempotencyKey:randomUUID(),body:product()})).rejects.toBeDefined();
    expect((x.f.store as MemoryBusinessStore).state.products.size).toBe(0);
  });
  it('rolls back product and audit on permission revision change at the final fence',async()=>{
    const x=setup(),original=x.transport.post.getMockImplementation()!;let calls=0;
    x.transport.post.mockImplementation(async(q,b)=>{if(++calls===3)x.state.revision='b'.repeat(64);return original(q,b);});
    await expect(x.execute('PRODUCTS_CREATE',{idempotencyKey:randomUUID(),body:product()})).rejects.toBeDefined();
    const state=(x.f.store as MemoryBusinessStore).state;expect(state.products.size).toBe(0);expect(state.operations).toHaveLength(0);
  });
  it('rechecks owner authority for an idempotent replay',async()=>{
    const x=setup(),fields={idempotencyKey:randomUUID(),body:customer()};await x.execute('CUSTOMERS_CREATE',fields);x.state.permission=false;
    await expect(x.execute('CUSTOMERS_CREATE',fields)).rejects.toMatchObject({code:'BILLING_CURRENT_AUTHORITY_REQUIRED'});
    expect((x.f.store as MemoryBusinessStore).state.customers.size).toBe(1);
  });
  it('rejects unwrapped, nested, mismatched action/binding and SERVICE requests',async()=>{
    const x=setup(),request={principal:x.f.principal,binding:x.f.b,action:'CUSTOMERS_LIST' as const};
    await expect(x.host.businessPermissions.authorizeCurrent(request)).rejects.toMatchObject({status:403});
    for(const change of [{action:'PRODUCTS_LIST'},{binding:x.f.other}]){
      const core=x.host.wrapBusinessExecutor({execute:async()=>{
        await x.host.businessPermissions.authorizeCurrent({...request,...change} as any);return {data:[],operationId:null,replayed:false};
      }});
      await expect(core.execute(x.auth,'CUSTOMERS_LIST',{binding:x.f.b})).rejects.toMatchObject({status:403});
    }
    const nested=x.host.wrapBusinessExecutor({execute:async()=>x.engine.execute(x.auth,'CUSTOMERS_LIST',{binding:x.f.b})});
    await expect(nested.execute(x.auth,'CUSTOMERS_LIST',{binding:x.f.b})).rejects.toMatchObject({status:403});
    await expect(x.engine.execute({...x.auth,kind:'SERVICE'},'CUSTOMERS_LIST',{binding:x.f.b})).rejects.toMatchObject({status:403});
  });
  it('revokes inherited async work when execute returns or throws',async()=>{
    const x=setup();let escaped:()=>Promise<any>=async()=>null;
    const core=x.host.wrapBusinessExecutor({execute:async()=>{
      const {AsyncResource}=await import('node:async_hooks');
      escaped=AsyncResource.bind(()=>x.host.businessPermissions.authorizeCurrent({principal:x.f.principal,binding:x.f.b,action:'CUSTOMERS_LIST'}));
      return {data:[],operationId:null,replayed:false};
    }});
    await core.execute(x.auth,'CUSTOMERS_LIST',{binding:x.f.b});await expect(escaped()).rejects.toMatchObject({status:401});
    expect(x.transport.post).not.toHaveBeenCalled();
  });
  it('isolates overlapping executions, uses each exact bearer, and snapshots access/binding before awaits',async()=>{
    const x=setup(),seen:any[]=[];
    const core=x.host.wrapBusinessExecutor({execute:async(auth,action,input)=>{
      await new Promise<void>(r=>setTimeout(r,auth.token.endsWith('2')?1:5));
      seen.push({auth,input});await x.host.businessPermissions.authorizeCurrent({principal:x.f.principal,binding:input.binding,action});
      return {data:[],operationId:null,replayed:false};
    }});
    const second={...x.auth,token:'synthetic-oidc-request-000002'},a={...x.auth},input={binding:{...x.f.b}};
    const first=core.execute(a,'CUSTOMERS_LIST',input);a.token='tampered';input.binding.issuerId=2;
    await Promise.all([first,core.execute(second,'PRODUCTS_LIST',{binding:x.f.b})]);
    expect(x.state.requests.map(r=>r.bearer).sort()).toEqual([x.auth.token,second.token]);
    expect(seen.every(v=>v.input.binding.issuerId===x.f.b.issuerId)).toBe(true);
  });
  it('has no permissive default, honors shutdown and hides private dependencies',async()=>{
    const x=setup(),disabled=new BillingHostPermissions(x.transport);
    await expect(disabled.business(x.f.store,x.identity,x.f.context).execute(x.auth,'CUSTOMERS_LIST',{binding:x.f.b})).rejects.toMatchObject({status:503});
    x.host.close();await expect(x.execute('CUSTOMERS_LIST')).rejects.toMatchObject({status:503});
    expect(inspect(x.host,{showHidden:true,depth:8,customInspect:false})).not.toContain(x.auth.token);
    expect(JSON.stringify(x.host)).not.toMatch(/transport|bearer|token/);
  });
});
