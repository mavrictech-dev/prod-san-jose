import { describe,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { b2bCorrectionBindingKey,validB2bCorrectionBinding,validB2bPrincipal } from '../packages/contracts/src/b2b-security';
import { B2bCorrectionAuthority } from '../services/identity-service/src/b2b/correction-authority';
import { B2bCorrectionCatalogue,PrismaB2bCorrectionPairRepository } from '../services/billing-service/src/b2b/correction-catalogue';
import { BillingB2bCorrectionAuthorization } from '../services/billing-service/src/b2b/correction-authorization';
import { supplementActor } from '../services/billing-service/src/application/supplement-actor';
import { B2bCorrectionAuthorityModule } from '../services/identity-service/src/b2b/correction-http';
import { correctionFixture,pair } from './b2b-correction-authority.fixture';
import { binding,ctx,id } from './b2b-identity.fixture';
describe('B2B-06 explicit paired NC/ND authorization, no fiscal activation',()=>{
  it('does not expand legacy bindings or accept extra principal claims',()=>{
    expect(validB2bCorrectionBinding(pair())).toBe(true);expect(b2bCorrectionBindingKey(pair())).toContain(id(40));
    expect(validB2bCorrectionBinding({...pair(),noteSeriesId:binding.seriesId})).toBe(false);
    expect(validB2bCorrectionBinding({...pair(),reference:{...binding,documentType:'07'}})).toBe(false);
    expect(validB2bCorrectionBinding({...pair(),noteType:'08'})).toBe(true);
    expect(validB2bCorrectionBinding({...pair(),environment:'PRODUCTION'})).toBe(false);
    expect(validB2bPrincipal({correctionBindings:[pair()]})).toBe(false);
  });
  it('has no implicit grant even with actual SERVICE token and issue scope',async()=>{
    const f=await correctionFixture();await expect(f.authorize()).rejects.toMatchObject({status:404});
    expect(f.catalogue.validate).not.toHaveBeenCalled();
    expect(f.grants.size).toBe(0);expect(f.users.current).not.toHaveBeenCalled();
  });
  it('creates an explicit audited pair and returns a typed SERVICE, never a fabricated human',async()=>{
    const f=await correctionFixture();await f.replace();const r=await f.authorize();
    expect(r).toMatchObject({grantRevision:1,clientRevision:1,candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false});
    expect(r.actor.userId).toBe(null);expect(supplementActor(r.actor)).toEqual(r.actor);
    expect(r.actor.scope.series).toEqual([binding.seriesId,id(40)]);
    expect(f.grants.size).toBe(1);expect(f.catalogue.validate).toHaveBeenCalledTimes(2);
    expect(f.store).not.toHaveProperty('reserve');expect(f.store).not.toHaveProperty('issue');
  });
  it.each([
    ()=>({...pair(),noteType:'08'}),()=>({...pair(),noteSeriesId:id(41)}),
    ()=>({...pair(),reference:{...binding,branchId:id(44)}}),()=>({...pair(),reference:{...binding,pointId:id(45)}}),
    ()=>({...pair(),reference:{...binding,issuerId:2}}),()=>({...pair(),reference:{...binding,issuerRuc:'00000000002'}}),
    ()=>({...pair(),reference:{...binding,seriesId:id(46)}}),()=>({...pair(),reference:{...binding,documentType:'03'}}),
  ])('rejects a cross-product or ungranted pair %#',async change=>{
    const f=await correctionFixture();await f.replace();await expect(f.authorize(change())).rejects.toMatchObject({status:404});
  });
  it('validates before storage and denies unowned or duplicate enrollment',async()=>{
    const f=await correctionFixture();
    for(const bindings of [[pair(),pair()],[{...pair(),noteType:'01'}],[{...pair(),reference:{...binding,pointId:id(90)}}]])await expect(f.replace(bindings)).rejects.toMatchObject({status:400});
    expect(f.grants.size).toBe(0);
    await expect(f.core.replace('password-only',f.made.client.id,{bindings:[pair()],expectedClientRevision:1,expectedGrantRevision:0},ctx())).rejects.toMatchObject({status:403});
  });
  it('requires both issue and correction scopes, not merely a valid client',async()=>{
    const f=await correctionFixture();await f.identity.change('human-step-up',f.made.client.id,{expectedRevision:1,scopes:['b2b:documents:read']},ctx());
    await expect(f.replace([pair()],0,2)).rejects.toMatchObject({status:400});
  });
  it('revision-CAS serializes concurrent edits and empty grants revoke next request',async()=>{
    const f=await correctionFixture();const results=await Promise.allSettled([f.replace(),f.replace()]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.grants.get(f.made.client.id)?.revision).toBe(1);
    await f.replace([],1);await expect(f.authorize()).rejects.toMatchObject({status:404});
  });
  it('does not inherit an old pair after normal client rotation/revision changes',async()=>{
    const f=await correctionFixture();await f.replace();await f.identity.change('human-step-up',f.made.client.id,{expectedRevision:1},ctx(),true);
    await expect(f.authorize()).rejects.toMatchObject({status:401});
    const view=await f.core.read('human-step-up',f.made.client.id,ctx());expect(view).toMatchObject({revision:1,current:false,clientRevision:2,grantedClientRevision:1});
  });
  it('denies a client revision changed between introspection and grant lookup',async()=>{
    const f=await correctionFixture();await f.replace();
    const core=new B2bCorrectionAuthority(f.store,{authenticate:async(token,scopes,context,kind)=>{
      const p=await f.identity.authenticate(token,scopes,context,kind);
      await f.identity.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());return p;
    }},f.catalogue,f.admin);
    await expect(core.authorize(f.token,{binding:pair(),kind:'SERVICE'},ctx())).rejects.toMatchObject({status:404});
  });
  it('audit/catalogue failure is fail-closed and rolls back a grant update',async()=>{
    const f=await correctionFixture();f.catalogue.validate.mockRejectedValueOnce(new Error('owner down'));
    await expect(f.replace()).rejects.toMatchObject({status:503});expect(f.grants.size).toBe(0);
    f.memory.failAudit=true;
    // Shared memory transaction rolls back both the new pair and its audit.
    await expect(f.replace()).rejects.toMatchObject({status:503});expect(f.grants.size).toBe(0);
    f.memory.failAudit=false;await f.replace();f.catalogue.validate.mockRejectedValueOnce(new Error('owner down'));
    await expect(f.authorize()).rejects.toMatchObject({status:503});
  });
  it('requires distinct privileged enrollment and Billing owner TLS peers',()=>{
    const f='a'.repeat(64),g='b'.repeat(64);
    expect(()=>B2bCorrectionAuthorityModule.isolated({} as any,{admin:[f],owner:[f]})).toThrow();
    expect(()=>B2bCorrectionAuthorityModule.isolated({} as any,{admin:[f],owner:[g]})).not.toThrow();
  });
  it('USER needs the note-series assignment too, not only the original invoice series',async()=>{
    const f=await correctionFixture('USER');await f.replace();const r=await f.authorize();
    expect(supplementActor(r.actor).userId).toBe(id(50));
    f.users.current.mockResolvedValueOnce({active:true,authVersion:3,permissions:['document.view','document.issue'],scope:{kind:'ASSIGNED',branchIds:[binding.branchId],emissionPointIds:[binding.pointId],series:[binding.seriesId]}});
    await expect(f.authorize()).rejects.toMatchObject({status:404});
    expect(f.memory.audits.at(-1)).toMatchObject({action:'AUTHORIZE_CORRECTION_PAIR',outcome:'DENIED',actorId:id(50)});
  });
  it.each(['revoked-link','inactive','auth-version','permission','point'])('USER fresh local %s revocation fails closed',async mode=>{
    const f=await correctionFixture('USER');await f.replace();
    const user={active:mode!=='inactive',authVersion:mode==='auth-version'?4:3,permissions:mode==='permission'?['document.view']:['document.view','document.issue'],
      scope:{kind:'ASSIGNED' as const,branchIds:[binding.branchId],emissionPointIds:[mode==='point'?id(99):binding.pointId],series:[binding.seriesId,id(40)]}};
    f.users.current.mockResolvedValueOnce(mode==='revoked-link'?null:user);
    await expect(f.authorize()).rejects.toMatchObject({status:404});
  });
  it('does not mask a USER authority outage as successful or reusable authorization',async()=>{
    const f=await correctionFixture('USER');await f.replace();f.users.current.mockRejectedValueOnce(new Error('down'));
    await expect(f.authorize()).rejects.toMatchObject({status:503});
  });
  it.each(['extra-series','client','subject','grant-revision','pair','activation','extra-field'])('Billing rejects altered private authority response: %s',async mode=>{
    const f=await correctionFixture();await f.replace();const r:any=await f.authorize();
    if(mode==='extra-series')r.actor.scope.series.push(id(88));
    if(mode==='client')r.actor.b2b.clientId=id(88);
    if(mode==='subject')r.actor.userId=id(88);
    if(mode==='grant-revision')r.grantRevision=0;
    if(mode==='pair')r.binding.noteType='08';
    if(mode==='activation')r.fiscalExecutionEnabled=true;
    if(mode==='extra-field')r.productionAllowed=true;
    const port=new BillingB2bCorrectionAuthorization({authenticate:(t,s,k)=>f.identity.authenticate(t,s,ctx(),k)},{post:async()=>r});
    await expect(port.current(f.token,'SERVICE',pair())).rejects.toMatchObject({status:503,code:'INVALID_CORRECTION_AUTHORITY_RESPONSE'});
  });
  it('canonical catalogue checks active whole hierarchies and maps 07/08 explicitly',async()=>{
    const findMany=vi.fn(async()=>[{id:binding.seriesId,series:'F001'},{id:id(40),series:'FC01'}]);
    const repo=new PrismaB2bCorrectionPairRepository({seriesCounter:{findMany}} as any),catalogue=new B2bCorrectionCatalogue(repo);
    expect(await catalogue.validate([pair()])).toEqual({valid:true});
    expect(findMany.mock.calls[0][0]).toMatchObject({where:{active:true,companyId:1,emissionPointId:binding.pointId,company:{ruc:binding.issuerRuc,environment:'BETA',active:true},OR:[{id:binding.seriesId,documentType:'INVOICE'},{id:id(40),documentType:'CREDIT_NOTE'}]}});
    await catalogue.validate([{...pair(),noteType:'08'}]);expect(findMany.mock.calls[1][0].where.OR[1].documentType).toBe('DEBIT_NOTE');
    findMany.mockResolvedValueOnce([{id:binding.seriesId,series:'F001'},{id:id(40),series:'BC01'}]);await expect(catalogue.validate([pair()])).rejects.toMatchObject({status:400});
    findMany.mockResolvedValueOnce([{id:binding.seriesId,series:'F001'}]);await expect(catalogue.validate([pair()])).rejects.toMatchObject({status:400});
  });
  it('candidate-only modules do not register in active bootstrap or open fiscal guards',()=>{
    for(const service of ['billing-service','identity-service'])for(const file of ['app.module.ts','main.ts'])expect(readFileSync(`services/${service}/src/${file}`,'utf8')).not.toContain('B2bCorrection');
    for(const file of ['beta-supplement-command.service.ts','financial-ledger-candidate.service.ts'])expect(readFileSync(`services/billing-service/src/application/${file}`,'utf8')).toContain('never');
    const sql=readFileSync('services/identity-service/b2b-correction-grants-schema.candidate.sql','utf8');expect(sql).toContain('BEFORE UPDATE OR DELETE');expect(sql).toContain('BETA');
  });
});
