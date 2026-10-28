import {describe,it,expect,vi} from 'vitest';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {BillingGuidePreparation,GUIDE_PREPARATION_GATES} from '../services/billing-service/src/b2b/guide-preparation';
import {guideFixture,guideKey} from './helpers/b2b-guide.fixture';
import {guidePreparationBody} from './helpers/guide-preparation.fixture';

async function fixture(){
  const f=guideFixture(),body=guidePreparationBody(),made=await f.command('CREATE',null,guideKey,undefined,body),id=made.response.id;
  await f.command('READY',id,guideKey+'_ready','"v1"',{});
  const issuer={current:vi.fn(async()=>({ruc:body.sender.ruc,legalName:body.sender.legalName,metadataSha256:'a'.repeat(64)}))};
  const fresh=vi.fn(async()=>{}),guard={assertLocalMapping:vi.fn(async()=>({fresh}))},core=new BillingGuidePreparation(f.core,issuer,guard);
  return{...f,id,body,issuer,guard,fresh,core,run:()=>core.prepare(f.token,f.kind,f.binding,id,'"v2"')};
}
describe('B2B07 local establishment map guard in read-only preparation',()=>{
  it('checks exact authorized source then revalidates map without changing plan gates or persistence',async()=>{
    const f=await fixture(),before=structuredClone(f.store.state),result=await f.run();
    expect(f.guard.assertLocalMapping).toHaveBeenCalledWith(f.binding,f.body);expect(f.fresh).toHaveBeenCalledTimes(1);
    expect(result.gates).toEqual(GUIDE_PREPARATION_GATES);expect(result.plan.officialRulesValidated).toBe(false);
    expect(result.authorizedForTransfer).toBe(false);expect(f.store.state).toEqual(before);
    expect(result).not.toHaveProperty('registry');expect(result.plan).not.toHaveProperty('number');
  });
  it.each(['ESTABLISHMENT_REGISTRY_REQUIRED','ESTABLISHMENT_REGISTRY_STALE','ESTABLISHMENT_MAPPING_MISMATCH','ESTABLISHMENT_BRANCH_REVISION_CONFLICT'])('fails closed before returning a plan when %s',async code=>{
    const f=await fixture(),before=structuredClone(f.store.state);f.guard.assertLocalMapping.mockRejectedValue(new B2bSecurityError(409,code));
    await expect(f.run()).rejects.toMatchObject({status:409,code});expect(f.fresh).not.toHaveBeenCalled();expect(f.store.state).toEqual(before);
  });
  it('checks live guide authorization before consulting a local registry',async()=>{
    const f=await fixture();f.control.revoked=true;await expect(f.run()).rejects.toMatchObject({status:401});
    expect(f.guard.assertLocalMapping).not.toHaveBeenCalled();expect(f.issuer.current).not.toHaveBeenCalled();
  });
  it('does not return a prepared response if the registry changes at the final boundary',async()=>{
    const f=await fixture(),before=structuredClone(f.store.state);f.fresh.mockRejectedValue(new B2bSecurityError(409,'ESTABLISHMENT_MAPPING_CHANGED'));
    await expect(f.run()).rejects.toMatchObject({status:409,code:'ESTABLISHMENT_MAPPING_CHANGED'});expect(f.store.state).toEqual(before);
  });
  it('rejects an unsupported profile before consulting the optional registry',async()=>{
    const f=await fixture();f.issuer.current.mockResolvedValue({ruc:f.body.sender.ruc,legalName:'DIFFERENT',metadataSha256:'a'.repeat(64)});
    await expect(f.run()).rejects.toMatchObject({status:409});expect(f.guard.assertLocalMapping).not.toHaveBeenCalled();
  });
  it('preserves the older advisory factory contract when no strict guard is supplied',async()=>{
    const f=await fixture();
    // Real guide owner, not the preparer itself.
    const advisory=new BillingGuidePreparation(f.restart(),f.issuer),result=await advisory.prepare(f.token,f.kind,f.binding,f.id,'"v2"');
    expect(result.gates).toContain('ESTABLISHMENT_MAPPING');expect(f.guard.assertLocalMapping).not.toHaveBeenCalled();
  });
  it.each([null,undefined,{}, {fresh:true}])('rejects an invalid strict guard result rather than falling back to advisory %#',async result=>{
    const f=await fixture();f.guard.assertLocalMapping.mockResolvedValue(result as any);
    await expect(f.run()).rejects.toMatchObject({status:503,code:'INVALID_ESTABLISHMENT_GUARD'});
  });
});
