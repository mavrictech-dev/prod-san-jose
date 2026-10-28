import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {BillingGuidePreparation,PrismaGuidePreparationIssuer,GUIDE_PREPARATION_GATES} from '../services/billing-service/src/b2b/guide-preparation';
import {guideFixture,guideKey,guideUuid} from './helpers/b2b-guide.fixture';
import {guidePreparationBody} from './helpers/guide-preparation.fixture';

async function fixture(kind:'USER'|'SERVICE'='SERVICE',ready=true){
  const f=guideFixture(kind),body=guidePreparationBody();
  const made=await f.command('CREATE',null,guideKey,undefined,body),id=made.response.id;
  if(ready)await f.command('READY',id,guideKey+'_ready','"v1"',{});
  const source=await f.read(id),metadata={ruc:body.sender.ruc,legalName:body.sender.legalName,metadataSha256:'b'.repeat(64)},issuer={current:vi.fn(async()=>structuredClone(metadata))};
  const core=new BillingGuidePreparation(f.core,issuer),run=(etag=source.revision)=>core.prepare(f.token,kind,f.binding,id,etag);
  return{...f,body,id,source,metadata,issuer,preparer:core,run};
}
describe('B2B07 owner preparation reads a READY draft without changing any aggregate',()=>{
  it.each(['SERVICE','USER'] as const)('preserves %s identity, source revision and unverified gates',async kind=>{
    const f=await fixture(kind),before=structuredClone(f.store.state),result=await f.run();
    expect(result).toMatchObject({schemaVersion:'factuez.b2b.guide-preparation.v1',binding:f.binding,
      plan:{draftId:f.id,draftRevision:'"v2"',draftBodySha256:f.source.bodySha256,issuer:{ruc:f.body.sender.ruc,legalName:f.body.sender.legalName},numberReserved:false,signatureVerified:false,officialRulesValidated:false},
      gates:GUIDE_PREPARATION_GATES,candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false,authorizedForTransfer:false});
    expect(f.store.state).toEqual(before);expect(f.issuer.current).toHaveBeenCalledTimes(2);
  });
  it('repeats preparation deterministically without any idempotency or operation record',async()=>{
    const f=await fixture(),before=structuredClone(f.store.state);expect(await f.run()).toEqual(await f.run());expect(f.store.state).toEqual(before);
  });
  it('refuses a non-READY draft before looking up issuer metadata',async()=>{
    const f=await fixture('SERVICE',false);await expect(f.run()).rejects.toMatchObject({status:409,code:'READY_GUIDE_REQUIRED'});expect(f.issuer.current).not.toHaveBeenCalled();
  });
  it('refuses a cancelled draft, without creating a replacement',async()=>{
    const f=await fixture();await f.command('CANCEL',f.id,guideKey+'_cancel','"v2"',{});
    await expect(f.run('"v3"')).rejects.toMatchObject({status:409,code:'READY_GUIDE_REQUIRED'});expect(f.store.rows.size).toBe(1);
  });
  it('requires the exact current revision',async()=>{
    const f=await fixture();await expect(f.run('"v1"')).rejects.toMatchObject({status:412});expect(f.issuer.current).not.toHaveBeenCalled();
  });
  it.each(['', 'v2','W/"v2"','"v0"','"v1000000000"'])('rejects invalid preparation ETag %s',async tag=>{
    const f=await fixture();await expect(f.run(tag)).rejects.toMatchObject({status:428});expect(f.issuer.current).not.toHaveBeenCalled();
  });
  it('reauthorizes ownership before any issuer lookup or profile details',async()=>{
    const f=await fixture();f.control.revoked=true;await expect(f.run()).rejects.toMatchObject({status:401});expect(f.issuer.current).not.toHaveBeenCalled();
  });
  it('cannot prepare another application or subject draft',async()=>{
    const f=await fixture();f.access.actor.b2b!.clientId=guideUuid(500);await expect(f.run()).rejects.toMatchObject({status:404});expect(f.issuer.current).not.toHaveBeenCalled();
  });
  it.each(['ruc','legalName','metadataSha256','missing'] as const)('denies wrong or missing owner metadata: %s',async field=>{
    const f=await fixture();if(field==='missing')f.issuer.current.mockResolvedValue(null as any);
    else f.metadata[field]=field==='ruc'?'20000000010':field==='metadataSha256'?'bad':'OTHER OWNER';
    await expect(f.run()).rejects.toMatchObject({status:field==='legalName'?409:404});
  });
  it('does not accept caller supplied issuer data or proposed fiscal number',async()=>{
    const f=await fixture(),result=await f.run();expect(result).not.toHaveProperty('xml');expect(result.plan).not.toHaveProperty('number');
    expect(result.plan).not.toHaveProperty('series');expect(result.plan).not.toHaveProperty('cdr');
  });
  it.each(['issuerRevision','issuerName','issuerDisappears','cancel','revoke'] as const)('withholds a plan when source/authority changes during preparation: %s',async mode=>{
    const f=await fixture();let calls=0;f.issuer.current.mockImplementation(async()=>{
      if(++calls===2){if(mode==='issuerRevision')return{...f.metadata,metadataSha256:'c'.repeat(64)};
        if(mode==='issuerName')return{...f.metadata,legalName:'CHANGED'};
        if(mode==='issuerDisappears')return null as any;
        if(mode==='cancel')await f.command('CANCEL',f.id,guideKey+'_other','"v2"',{});
        if(mode==='revoke')f.control.revoked=true;}
      return structuredClone(f.metadata);
    });
    await expect(f.run()).rejects.toMatchObject({status:mode==='revoke'?401:409});
  });
  it.each(['id','binding','schemaVersion','candidateOnly','authorizedForTransfer'] as const)('rejects inconsistent source read: %s',async field=>{
    const f=await fixture(),bad:any=structuredClone(f.source);
    bad[field]=field==='id'?guideUuid(600):field==='binding'?{...f.binding,guideType:'31'}:field==='candidateOnly'?false:field==='authorizedForTransfer'?true:'unknown';
    const p=new BillingGuidePreparation({read:async()=>bad},f.issuer);await expect(p.prepare(f.token,f.kind,f.binding,f.id,f.source.revision)).rejects.toMatchObject({status:503});
  });
  it('does not expose an unsupported GT profile before authorized read',async()=>{
    const f=guideFixture('SERVICE','31');const created=await f.command(),id=created.response.id;
    await f.command('READY',id,guideKey+'_ready','"v1"',{});
    const issuer={current:vi.fn()},p=new BillingGuidePreparation(f.core,issuer);
    await expect(p.prepare(f.token,f.kind,f.binding,id,'"v2"')).rejects.toMatchObject({code:'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'});
    f.control.revoked=true;await expect(p.prepare(f.token,f.kind,f.binding,id,'"v2"')).rejects.toMatchObject({status:401});expect(issuer.current).not.toHaveBeenCalled();
  });
});
describe('B2B07 issuer metadata owner',()=>{
  it('selects only exact BETA issuer metadata, not certificate or SOL secrets',async()=>{
    const binding=guideFixture().binding,row={id:binding.anchor.issuerId,ruc:binding.anchor.issuerRuc,legalName:'FICTIONAL',environment:'BETA',configVersion:4};
    const db={companySettings:{findFirst:vi.fn(async()=>row)}},port=new PrismaGuidePreparationIssuer(db as any);
    expect(await port.current(binding)).toEqual({ruc:row.ruc,legalName:row.legalName,metadataSha256:fiscalSnapshotSha256(row)});
    expect(db.companySettings.findFirst).toHaveBeenCalledWith({where:{id:binding.anchor.issuerId,ruc:binding.anchor.issuerRuc,environment:'BETA',active:true},select:{id:true,ruc:true,legalName:true,environment:true,configVersion:true}});
  });
  it('no issuer is created when metadata is absent',async()=>{
    const port=new PrismaGuidePreparationIssuer({companySettings:{findFirst:async()=>null}} as any);expect(await port.current(guideFixture().binding)).toBeNull();
  });
  it('invalid binding never queries owner DB',async()=>{
    const findFirst=vi.fn(),port=new PrismaGuidePreparationIssuer({companySettings:{findFirst}} as any);
    expect(await port.current({} as any)).toBeNull();expect(findFirst).not.toHaveBeenCalled();
  });
  it('has no fiscal writer, signer, transmission or implicit establishment mapping',()=>{
    const code=readFileSync(new URL('../services/billing-service/src/b2b/guide-preparation.ts',import.meta.url),'utf8');
    expect(code).not.toMatch(/\.create\(|\.update\(|\$executeRaw|fetch\(|process\.env|certificate|solPassword/);
    expect(GUIDE_PREPARATION_GATES).toContain('ESTABLISHMENT_MAPPING');expect(GUIDE_PREPARATION_GATES).toContain('CATALOGUES_AND_REGULATED_GOODS');
  });
});
