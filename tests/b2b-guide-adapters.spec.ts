import {describe,it,expect,vi} from 'vitest';
import {validB2bGuideBinding} from '../packages/contracts/src/b2b-guide-security';
import type {B2bPrincipal,B2bIdentityScope} from '../packages/contracts/src/b2b-security';
import {BillingB2bGuideAuthorization,type GuideAccess} from '../services/billing-service/src/b2b/guide-authorization';
import {PrismaGuideDraftCatalogue} from '../services/billing-service/src/b2b/guide-catalogue';
import {B2bGuideCatalogueHttp} from '../packages/service-access/src/b2b';
import {guideFixture,guideBinding,guideUuid} from './helpers/b2b-guide.fixture';

function authority(kind:'SERVICE'|'USER'='SERVICE',action:GuideAccess='READ'){
  const f=guideFixture(kind),scopes:B2bIdentityScope[]=['b2b:documents:read','b2b:guides:read','b2b:guides:write','b2b:guide-operations:read'];
  const principal:B2bPrincipal={...f.access.actor.b2b!,environment:'BETA',scopes,bindings:[f.binding.anchor]};
  const response={schemaVersion:'factuez.b2b.guide-authorization.v1',binding:structuredClone(f.binding),action,
    actor:structuredClone(f.access.actor),clientRevision:1,grantRevision:1,candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false};
  const identity={authenticate:vi.fn(async()=>structuredClone(principal))},http={post:vi.fn(async()=>structuredClone(response))};
  return{...f,principal,response,identity,http,core:new BillingB2bGuideAuthorization(identity,http),
    run:()=>new BillingB2bGuideAuthorization(identity,http).current(f.token,kind,f.binding,action)};
}
describe('B2B07 private guide authorization adapter',()=>{
  it.each(['SERVICE','USER'] as const)('preserves exact %s identity and independently scoped pair',async kind=>{
    const f=authority(kind);expect(await f.run()).toEqual(f.access);
    expect(f.http.post).toHaveBeenCalledWith('/internal/b2b/authorize-guide',{binding:f.binding,kind,action:'READ'},f.token);
  });
  it.each(['READ','WRITE','OPERATION'] as const)('requests minimal %s scopes',async action=>{
    const f=authority('SERVICE',action);await f.run();
    expect(f.identity.authenticate).toHaveBeenCalledWith(f.token,['b2b:documents:read',action==='WRITE'?'b2b:guides:write':'b2b:guides:read',...(action==='OPERATION'?['b2b:guide-operations:read']:[])],'SERVICE');
  });
  it.each([
    (r:any)=>r.candidateOnly=false,(r:any)=>r.fiscalExecutionEnabled=true,(r:any)=>r.transmissionAuthorized=true,
    (r:any)=>r.clientRevision=2,(r:any)=>r.grantRevision=0,(r:any)=>r.grantRevision=1.5,
    (r:any)=>r.schemaVersion='unknown',(r:any)=>r.action='WRITE',(r:any)=>r.extra='unexpected',
    (r:any)=>r.binding.guideType='31',(r:any)=>r.binding.guideSeriesId=guideUuid(50),
    (r:any)=>r.actor.b2b.clientId=guideUuid(51),(r:any)=>r.actor.b2b.revision=2,
    (r:any)=>r.actor.scope.branchIds.push(guideUuid(52)),(r:any)=>r.actor.scope.emissionPointIds=[guideUuid(53)],
    (r:any)=>r.actor.scope.series=[r.binding.guideSeriesId,r.binding.guideSeriesId],
    (r:any)=>r.actor.userId=guideUuid(54),
  ])('rejects malformed or over-privileged private response %#',async mutate=>{
    const f=authority();mutate(f.response);await expect(f.run()).rejects.toMatchObject({status:503,code:'INVALID_GUIDE_AUTHORITY_RESPONSE'});
  });
  it('cannot substitute a different human delegation',async()=>{
    const f=authority('USER');f.response.actor.userId=guideUuid(55);f.response.actor.b2b!.subjectId=guideUuid(55);
    await expect(f.run()).rejects.toMatchObject({status:503});
  });
  it.each(['scope','anchor','kind'] as const)('denies invalid fresh principal before private authority: %s',async field=>{
    const f=authority();if(field==='scope')f.principal.scopes=[];
    if(field==='anchor')f.principal.bindings=[{...f.binding.anchor,pointId:guideUuid(56)}];
    if(field==='kind')(f.principal as any).kind='USER';
    await expect(f.run()).rejects.toMatchObject({status:401});expect(f.http.post).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable authority',async()=>{
    const f=authority();f.http.post.mockRejectedValueOnce(new Error('private authority unavailable'));
    await expect(f.run()).rejects.toMatchObject({status:503});
  });
});
describe('B2B07 guide binding data-only boundary',()=>{
  it.each(['09','31'] as const)('accepts only independent %s metadata slot',type=>expect(validB2bGuideBinding(guideBinding(type))).toBe(true));
  it.each(['outer','anchor','proxy','coercion','prototype'] as const)('rejects %s without executing user code',mode=>{
    const b:any=guideBinding(),execute=vi.fn(()=>{throw new Error('must not run');});
    if(mode==='outer')Object.defineProperty(b,'guideType',{get:execute,enumerable:true});
    if(mode==='anchor')Object.defineProperty(b.anchor,'issuerId',{get:execute,enumerable:true});
    if(mode==='proxy')b.anchor=new Proxy(b.anchor,{get:execute});
    if(mode==='coercion')b.anchor.documentType={toString:execute};
    if(mode==='prototype')Object.setPrototypeOf(b,{hidden:true});
    expect(validB2bGuideBinding(b)).toBe(false);expect(execute).not.toHaveBeenCalled();
  });
  it('does not accept an invoice counter as guide slot or a production context',()=>{
    const b=guideBinding();expect(validB2bGuideBinding({...b,guideSeriesId:b.anchor.seriesId})).toBe(false);
    expect(validB2bGuideBinding({...b,anchor:{...b.anchor,environment:'PRODUCTION'}})).toBe(false);
  });
});
describe('B2B07 read-only catalogue adapter',()=>{
  function fixture(){const b=guideBinding(),row={id:b.guideSeriesId,companyId:1,pointId:b.anchor.pointId,guideType:'09',label:'T001',revision:1,purpose:'DRAFT_ONLY',
    ruc:b.anchor.issuerRuc,environment:'BETA',branchId:b.anchor.branchId,pointCode:'POINT',anchorSeriesId:b.anchor.seriesId,anchorLabel:'F001',documentType:'INVOICE'};
    const db={$queryRawUnsafe:vi.fn(async()=>[structuredClone(row)])};return{b,row,db,core:new PrismaGuideDraftCatalogue(db as any)};}
  it('passes every hierarchy member as parameters, selects only metadata, never updates',async()=>{
    const f=fixture(),result=await f.core.resolve(f.b);expect(result).toMatchObject({binding:f.b,seriesLabel:'T001',metadataSha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
    const [sql,...params]=f.db.$queryRawUnsafe.mock.calls[0] as unknown as [string,...unknown[]];
    expect(sql).toContain('c."environment"=\'BETA\'');expect(sql).toContain('g."purpose"=\'DRAFT_ONLY\'');
    expect(sql).not.toMatch(/SELECT\s+\*|\b(?:UPDATE|INSERT|DELETE)\b|password|certificate|secret/i);
    expect(params).toEqual([f.b.guideSeriesId,f.b.anchor.seriesId,1,f.b.anchor.issuerRuc,f.b.anchor.branchId,f.b.anchor.pointId,'09']);
  });
  it('fingerprint changes when registry revision changes',async()=>{
    const f=fixture(),first=await f.core.resolve(f.b);f.row.revision++;expect((await f.core.resolve(f.b))?.metadataSha256).not.toBe(first?.metadataSha256);
  });
  it.each(['empty','multiple','wrong-type'] as const)('rejects %s result',async mode=>{
    const f=fixture();f.db.$queryRawUnsafe.mockResolvedValueOnce(mode==='empty'?[]:mode==='multiple'?[f.row,f.row]:[{...f.row,documentType:'CREDIT_NOTE'}]);
    expect(await f.core.resolve(f.b)).toBeNull();
  });
  it('validates the actual boleta anchor, not a permissive default for guide types',async()=>{
    const f=fixture();f.b.anchor.documentType='03';f.row.documentType='SALES_RECEIPT';expect(await f.core.resolve(f.b)).not.toBeNull();
  });
  it.each([undefined,[],[guideBinding(),guideBinding()],[{...guideBinding(),guideType:'07'}]].map(values=>({values})))('rejects invalid enrollment without database reads %#',async ({values})=>{
    const f=fixture();await expect(f.core.validate(values)).rejects.toMatchObject({status:400});expect(f.db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('does not consult database for an invalid binding',async()=>{
    const f=fixture();expect(await f.core.resolve({...f.b,guideType:'01'} as any)).toBeNull();expect(f.db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('uses only the pinned catalogue RPC',async()=>{
    const http={post:vi.fn(async()=>({valid:true}))};await new B2bGuideCatalogueHttp(http).validate([guideBinding()]);
    expect(http.post).toHaveBeenCalledWith('/internal/b2b/validate-guide-bindings',{bindings:[guideBinding()]});
  });
  it.each([null,{},[],{valid:false},{valid:true,extra:true}])('denies malformed catalogue peer reply %#',async response=>{
    await expect(new B2bGuideCatalogueHttp({post:async()=>response}).validate([guideBinding()])).rejects.toMatchObject({status:400});
  });
});
