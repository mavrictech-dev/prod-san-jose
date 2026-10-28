import {describe,it,expect,vi} from 'vitest';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {BillingGuidePreparation,GUIDE_PREPARATION_GATES} from '../services/billing-service/src/b2b/guide-preparation';
import {createBillingCataloguedGuidePreparation} from '../services/billing-service/src/b2b/guide-assembly';
import {guideFixture,guideKey} from './helpers/b2b-guide.fixture';
import {guidePreparationBody} from './helpers/guide-preparation.fixture';
import {guideGoodsFixture} from './helpers/b2b-guide-goods.fixture';
import {establishmentFixture} from './helpers/b2b-guide-establishments.fixture';

async function fixture(){
  const f=guideFixture(),body=guidePreparationBody(),made=await f.command('CREATE',null,guideKey,undefined,body),id=made.response.id;
  await f.command('READY',id,guideKey+'_ready','"v1"',{});
  const issuer={current:vi.fn(async()=>({ruc:body.sender.ruc,legalName:body.sender.legalName,metadataSha256:'a'.repeat(64)}))};
  const mapFresh=vi.fn(async()=>{}),goodsFresh=vi.fn(async()=>{});
  const map={assertLocalMapping:vi.fn(async()=>({fresh:mapFresh}))},goods={assertLocalGoods:vi.fn(async()=>({fresh:goodsFresh}))};
  const core=new BillingGuidePreparation(f.core,issuer,map,goods);
  return{...f,id,body,issuer,map,goods,mapFresh,goodsFresh,core,run:()=>core.prepare(f.token,f.kind,f.binding,id,'"v2"')};
}
describe('B2B07 catalogue/goods port is explicit and never fiscal approval',()=>{
  it('consults both local controls and rechecks each without writing the draft, numbering or widening the response',async()=>{
    const f=await fixture(),before=structuredClone(f.store.state),result=await f.run();
    expect(f.goods.assertLocalGoods).toHaveBeenCalledExactlyOnceWith(f.binding,f.body);
    expect(f.mapFresh).toHaveBeenCalledTimes(1);expect(f.goodsFresh).toHaveBeenCalledTimes(1);
    expect(result.gates).toEqual(GUIDE_PREPARATION_GATES);expect(result.plan.officialRulesValidated).toBe(false);
    expect(result.plan.numberReserved).toBe(false);expect(result.transmissionAuthorized).toBe(false);
    expect(result).not.toHaveProperty('goods');expect(result).not.toHaveProperty('catalogue');expect(f.store.state).toEqual(before);
  });
  it('does not read classifications before draft authorization',async()=>{
    const f=await fixture();f.control.revoked=true;await expect(f.run()).rejects.toMatchObject({status:401});
    expect(f.goods.assertLocalGoods).not.toHaveBeenCalled();expect(f.issuer.current).not.toHaveBeenCalled();
  });
  it('does not consult goods when the establishment control rejects',async()=>{
    const f=await fixture();f.map.assertLocalMapping.mockRejectedValue(new B2bSecurityError(409,'ESTABLISHMENT_MAPPING_MISMATCH'));
    await expect(f.run()).rejects.toMatchObject({status:409});expect(f.goods.assertLocalGoods).not.toHaveBeenCalled();
  });
  it.each(['GUIDE_GOODS_POLICY_REQUIRED','GUIDE_GOODS_PRODUCT_CHANGED','GUIDE_GOODS_CLASSIFICATION_NOT_ENABLED','GUIDE_REFERENCE_CODE_NOT_ENABLED'])('fails closed on %s',async code=>{
    const f=await fixture(),before=structuredClone(f.store.state);f.goods.assertLocalGoods.mockRejectedValue(new B2bSecurityError(409,code));
    await expect(f.run()).rejects.toMatchObject({status:409,code});expect(f.goodsFresh).not.toHaveBeenCalled();expect(f.store.state).toEqual(before);
  });
  it.each([null,undefined,{}, {fresh:true}])('does not downgrade a malformed guard result to advisory %#',async result=>{
    const f=await fixture();f.goods.assertLocalGoods.mockResolvedValue(result as any);
    await expect(f.run()).rejects.toMatchObject({status:503,code:'INVALID_GUIDE_GOODS_GUARD'});
  });
  it('rejects a classification change during preparation',async()=>{
    const f=await fixture();f.goodsFresh.mockRejectedValue(new B2bSecurityError(409,'GUIDE_GOODS_POLICY_CHANGED'));
    await expect(f.run()).rejects.toMatchObject({status:409,code:'GUIDE_GOODS_POLICY_CHANGED'});
  });
  it('still reauthorizes source after the goods check',async()=>{
    const f=await fixture();f.goods.assertLocalGoods.mockImplementation(async()=>{f.control.revoked=true;return{fresh:f.goodsFresh};});
    await expect(f.run()).rejects.toMatchObject({status:401});expect(f.goodsFresh).not.toHaveBeenCalled();
  });
  it.each([[null,null],[{assertLocalMapping:async()=>({fresh:async()=>{}})},null],[null,{assertLocalGoods:async()=>({fresh:async()=>{}})}]])('strict assembly refuses missing controls %#',(map,goods)=>{
    expect(()=>createBillingCataloguedGuidePreparation({} as any,{} as any,map as any,goods as any)).toThrow('Explicit local guide controls required');
  });
});

describe('actual local controls compose with authorized guide owner',()=>{
  async function composed(kind:'SERVICE'|'USER'='SERVICE'){
    const guides=guideFixture(kind),goods=guideGoodsFixture(),map=establishmentFixture();
    await goods.replace();await map.replace();
    const created=await guides.command('CREATE',null,guideKey,undefined,goods.body),id=created.response.id;
    await guides.command('READY',id,guideKey+'_composed','"v1"',{});
    const issuer={current:async()=>({ruc:goods.body.sender.ruc,legalName:goods.body.sender.legalName,metadataSha256:'a'.repeat(64)})};
    const core=new BillingGuidePreparation(guides.core,issuer,map.core,goods.core);
    return{guides,goods,map,id,run:()=>core.prepare(guides.token,kind,guides.binding,id,'"v2"')};
  }
  it.each(['SERVICE','USER'] as const)('prepares owned READY for %s with two current policies, no new writes',async kind=>{
    const f=await composed(kind),before=[structuredClone(f.guides.store.state),structuredClone(f.goods.store.state),structuredClone(f.map.store.state)];
    const result=await f.run();expect(result.plan.body).toEqual(f.goods.body);expect(result.gates).toContain('CATALOGUES_AND_REGULATED_GOODS');
    expect(result.plan.officialRulesValidated).toBe(false);expect([f.guides.store.state,f.goods.store.state,f.map.store.state]).toEqual(before);
  });
  it('does not let regulatedGoods:false override the administrator classification',async()=>{
    const f=await composed();await f.goods.replace(f.goods.input(1,[{...f.goods.entries[0],classification:'REGULATED'}]));
    await expect(f.run()).rejects.toMatchObject({status:409,code:'GUIDE_GOODS_CLASSIFICATION_NOT_ENABLED'});
  });
  it('blocks an edited master even when the draft payload is unchanged',async()=>{
    const f=await composed();f.goods.store.state.products.get(f.goods.product.id)!.description='NUEVA DESCRIPCION';
    await expect(f.run()).rejects.toMatchObject({status:409,code:'GUIDE_GOODS_PRODUCT_CHANGED'});
  });
  it('does not consult the policy store after revoking a guide consumer',async()=>{
    const f=await composed(),before=f.goods.store.transactions.length;f.guides.control.revoked=true;
    await expect(f.run()).rejects.toMatchObject({status:401});expect(f.goods.store.transactions).toHaveLength(before);
  });
  it('rejects a withdrawn destination map before evaluating goods',async()=>{
    const f=await composed();await f.map.replace(f.map.input(1,[]));const before=f.goods.store.transactions.length;
    await expect(f.run()).rejects.toMatchObject({status:409,code:'ESTABLISHMENT_MAPPING_MISMATCH'});expect(f.goods.store.transactions).toHaveLength(before);
  });
});
