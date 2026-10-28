import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {B2bSecurityError,B2bEnabledIdentityScopes} from '../packages/contracts/src/b2b-security';
import {B2bCommercial} from '../services/billing-service/src/b2b/commercial';
import {commercialFixture,commercialInput} from './b2b-commercial.fixture';
import {fixture,ctx} from './b2b-identity.fixture';
import {invoiceBinding} from './b2b-read.fixture';
import {assessCorrectionDeclarations} from '../services/billing-service/src/b2b/correction-readiness';
const key='synthetic_commercial_command';
async function ready(){const f=await commercialFixture(),r=await f.command('CREATE',null,key,undefined,commercialInput());await f.command('COMPLETE',r.response.id,key+'c','"v1"');return {...f,id:r.response.id};}
describe('B2B-06 non-fiscal aggregate and atomic conversion',()=>{
  it('create/complete use independent commercial identity, not fiscal identity',async()=>{
    const f=await ready(),r=await f.core.read(f.token,'SERVICE','SALES_NOTE',1,f.id);
    expect(r).toMatchObject({state:'COMPLETED',fiscal:false,documentType:'NV',commercialNumber:'NV-00000001',revision:'"v2"',totals:{payableAmount:'118.00'}});expect(r.completedSha256).toMatch(/^[a-f0-9]{64}$/);expect(f.store.nextFiscal).toBe(1);expect(f.store.documents).toHaveLength(0);
  });
  it('editing requires exact ETag, recomputes totals, cannot change target or assign numbers',async()=>{
    const f=await commercialFixture(),r=await f.command('CREATE',null,key,undefined,commercialInput()),id=r.response.id;
    await expect(f.command('PATCH',id,key+'p',undefined,{issueDate:'2026-10-21'})).rejects.toMatchObject({status:428});
    await expect(f.command('PATCH',id,key+'p','"v2"',{issueDate:'2026-10-21'})).rejects.toMatchObject({status:412});
    await expect(f.command('PATCH',id,key+'p','"v1"',{seriesId:randomUUID()})).rejects.toMatchObject({status:400});
    const v=await f.command('PATCH',id,key+'p','"v1"',{lines:commercialInput().conversion.lines.map(l=>({...l,quantity:'2'}))});expect(v.response.totals.payableAmount).toBe('236.00');
    await f.command('COMPLETE',id,key+'c','"v2"');await expect(f.command('PATCH',id,key+'after','"v3"',{issueDate:'2026-10-22'})).rejects.toMatchObject({code:'COMMERCIAL_IMMUTABLE'});
  });
  it('parallel conversion/replay yields one document and one fiscal number',async()=>{
    const f=await ready(),r=await Promise.all(Array.from({length:8},()=>f.command('CONVERT',f.id,key+'i','"v2"')));
    expect(new Set(r.map(x=>x.response.issuance.documentId)).size).toBe(1);expect(r.filter(x=>!x.replayed)).toHaveLength(1);expect(f.store.nextFiscal).toBe(2);expect(f.store.documents).toHaveLength(1);
    expect(r[0].operation.state).toBe('COMMITTED');expect(r[0].response).toMatchObject({state:'CONVERTED',revision:'"v3"',fiscalAcceptance:'NOT_ASSERTED'});
    expect(f.store.documents[0].actor).toMatchObject({kind:'SERVICE',subjectId:null});expect(JSON.stringify([...f.store.ops.values()])).not.toContain(f.token);
  });
  it('other conversion keys cannot convert twice or cancel converted notes',async()=>{
    const f=await ready();await f.command('CONVERT',f.id,key+'i','"v2"');
    await expect(f.command('CONVERT',f.id,key+'other','"v3"')).rejects.toMatchObject({code:'COMMERCIAL_IMMUTABLE'});
    await expect(f.command('CANCEL',f.id,key+'cancel','"v3"')).rejects.toMatchObject({code:'COMMERCIAL_IMMUTABLE'});expect(f.store.documents).toHaveLength(1);
  });
  it('completion is mandatory and changing the frozen payload fails closed',async()=>{
    const f=await commercialFixture(),r=await f.command('CREATE',null,key,undefined,commercialInput());await expect(f.command('CONVERT',r.response.id,key+'i','"v1"')).rejects.toMatchObject({code:'SALES_NOTE_COMPLETION_REQUIRED'});
    await f.command('COMPLETE',r.response.id,key+'c','"v1"');const stored=f.store.rows.get(r.response.id)!;(stored.body as any).lines[0].quantity='3';
    await expect(f.command('CONVERT',r.response.id,key+'i','"v2"')).rejects.toMatchObject({code:'SALES_NOTE_COMPLETION_REQUIRED'});expect(f.store.documents).toHaveLength(0);
  });
  it('failed audit rolls back number, document, link and operation; same key can retry',async()=>{
    const f=await ready();f.store.failAppend=true;await expect(f.command('CONVERT',f.id,key+'i','"v2"')).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');
    expect(f.store.nextFiscal).toBe(1);expect(f.store.rows.get(f.id)?.state).toBe('COMPLETED');f.store.failAppend=false;
    expect((await f.command('CONVERT',f.id,key+'i','"v2"')).response.issuance.number).toBe('1');
  });
  it('failed CREATE audit leaves no commercial number gap',async()=>{
    const f=await commercialFixture();f.store.failAppend=true;await expect(f.command('CREATE',null,key,undefined,commercialInput())).rejects.toThrow();expect(f.store.numbers.size).toBe(0);expect(f.store.rows.size).toBe(0);f.store.failAppend=false;
    expect((await f.command('CREATE',null,key,undefined,commercialInput())).response.commercialNumber).toBe('NV-00000001');
  });
  it('lost response is recovered durably without accepting changed request hashes',async()=>{
    const f=await ready(),r=await f.command('CONVERT',f.id,key+'i','"v2"'),restart=new B2bCommercial(f.store,f.identity,f.context,true);
    expect(await restart.operation(f.token,'SERVICE',1,r.operation.operationId)).toEqual(r.operation);
    expect((await restart.command(f.token,'SERVICE','SALES_NOTE','CONVERT',1,f.id,key+'i','"v2"',{})).replayed).toBe(true);
    await expect(f.command('CONVERT',f.id,key+'i','"v3"')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('cancellation keeps history and never reuses a commercial number',async()=>{
    const f=await ready();await f.command('CANCEL',f.id,key+'x','"v2"');const n=await f.command('CREATE',null,key+'new',undefined,commercialInput('another'));
    expect(n.response.commercialNumber).toBe('NV-00000002');expect(f.store.nextFiscal).toBe(1);expect(f.store.rows.get(f.id)?.state).toBe('CANCELLED');
  });
  it('duplicate origin is rejected even with another command key',async()=>{
    const f=await ready();await expect(f.command('CREATE',null,key+'again',undefined,commercialInput())).rejects.toMatchObject({code:'COMMERCIAL_REFERENCE_CONFLICT'});expect(f.store.numbers.values().next().value).toBe(2);
  });
  it('conversion remains disabled when no explicit owner binding exists',async()=>{
    const f=await commercialFixture(false),r=await f.command('CREATE',null,key,undefined,commercialInput());await f.command('COMPLETE',r.response.id,key+'c','"v1"');await expect(f.command('CONVERT',r.response.id,key+'i','"v2"')).rejects.toMatchObject({code:'PROFILE_NOT_ENABLED'});expect(f.store.documents).toHaveLength(0);
  });
  it('scope revocation denies replay and read, with no new fiscal effect',async()=>{
    const f=await ready();await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());await expect(f.command('CONVERT',f.id,key+'i','"v2"')).rejects.toMatchObject({status:401});await expect(f.core.read(f.token,'SERVICE','SALES_NOTE',1,f.id)).rejects.toMatchObject({status:401});expect(f.store.documents).toHaveLength(0);
  });
  it('revocation just before commit rolls back local issuance',async()=>{
    const f=await ready();let calls=0;const base=f.identity.authenticate.getMockImplementation()!;f.identity.authenticate.mockImplementation(async(...args)=>{if(++calls===2)throw new B2bSecurityError(401,'REVOKED');return base(...args);});
    await expect(f.command('CONVERT',f.id,key+'i','"v2"')).rejects.toMatchObject({status:401});expect(f.store.documents).toHaveLength(0);expect(f.store.nextFiscal).toBe(1);
  });
  it('inactive context, another issuer, foreign client and foreign actor are hidden',async()=>{
    const f=await ready();await expect(f.core.read(f.token,'SERVICE','SALES_NOTE',2,f.id)).rejects.toMatchObject({status:404});
    const stored=f.store.rows.get(f.id)!;stored.actorKey='USER:'+randomUUID();await expect(f.command('CONVERT',f.id,key+'i','"v2"')).rejects.toMatchObject({status:404});stored.actorKey='SERVICE:-';stored.clientId=randomUUID();await expect(f.core.read(f.token,'SERVICE','SALES_NOTE',1,f.id)).rejects.toMatchObject({status:404});stored.clientId=f.made.client.id;
    f.context.resolve.mockResolvedValue(null as any);await expect(f.core.read(f.token,'SERVICE','SALES_NOTE',1,f.id)).rejects.toMatchObject({status:404});
  });
  it('list is bounded, authorized and explicit about non-snapshot pagination',async()=>{
    const f=await ready();await f.command('CREATE',null,key+'next',undefined,commercialInput('next'));const first=await f.core.list(f.token,'SERVICE','SALES_NOTE',1,1);
    expect(first.items).toHaveLength(1);expect(first.page).toMatchObject({limit:1,hasMore:true,consistency:'LIVE_KEYSET_NOT_A_SNAPSHOT'});const second=await f.core.list(f.token,'SERVICE','SALES_NOTE',1,1,first.page.nextAfter);expect(second.items).toHaveLength(1);expect(second.items[0].id).not.toBe(first.items[0].id);expect(second.page.hasMore).toBe(false);
    await expect(f.core.list(f.token,'SERVICE','SALES_NOTE',1,101)).rejects.toMatchObject({status:400});
  });
  it.each(['number','userId','environment','actor','seriesId'])('rejects caller authority at CREATE: %s',async field=>{
    const f=await commercialFixture();await expect(f.command('CREATE',null,key,undefined,{...commercialInput(),[field]:'forged'})).rejects.toMatchObject({status:400});expect(f.store.rows.size).toBe(0);
  });
});
describe('B2B-06 owner-side readiness is local observation, never spendable fiscal balance',()=>{
  async function intent(){const f=await commercialFixture(),made=await f.command('CREATE',null,key,undefined,{originalDocumentId:f.original.id,kind:'CREDIT_NOTE',reason:'Revisión sintética',proposedAmount:'118.00',externalReference:{namespace:'synthetic',value:'readiness'}},'CORRECTION_REQUEST');return {...f,id:made.response.id};}
  it('uses stored reference and returns blocked readiness without writes or fabricated acceptance',async()=>{
    const f=await intent(),before=structuredClone([...f.store.ops.values()]),result=await f.core.readiness(f.token,'SERVICE',1,f.id);
    expect(result).toMatchObject({readiness:'BLOCKED',fiscalExecutionEnabled:false,transmissionAuthorized:false,evidenceAuthenticityVerified:false,
      declarations:{observedCreditCount:0,illustrativeRemainingAmount:'118.00',spendableBalance:false,historyCompleteness:'NOT_VERIFIED',trust:'LOCAL_DECLARATIONS_NOT_FISCAL_EVIDENCE'}});
    expect(result.blockers).toContain('ATOMIC_FINANCIAL_LEDGER_PENDING');expect([...f.store.ops.values()]).toEqual(before);expect(f.store.documents).toHaveLength(0);expect(f.store.nextFiscal).toBe(1);
  });
  it('calculates exactly in integer cents and does not publish related note identities',async()=>{
    const f=await intent();f.store.credits=[{declaredAmount:'0.10',snapshotAmount:'0.10',currency:'PEN',referenceDocumentId:f.original.id,referenceSha256:f.original.snapshotSha256},{declaredAmount:'0.20',snapshotAmount:'0.20',currency:'PEN',referenceDocumentId:f.original.id,referenceSha256:f.original.snapshotSha256}];
    const r=await f.core.readiness(f.token,'SERVICE',1,f.id);expect(r.declarations).toMatchObject({observedCreditCount:2,observedCreditTotal:'0.30',illustrativeRemainingAmount:'117.70',rejectedProjectionsReleaseBalance:false});expect(JSON.stringify(r)).not.toContain('referenceDocumentId');
  });
  it.each([
    [{declaredAmount:'3.00',snapshotAmount:'2.00'},'CREDIT_DECLARATION_INCONSISTENT'],
    [{currency:'USD'},'CREDIT_CURRENCY_MISMATCH'],
    [{referenceSha256:'b'.repeat(64)},'CREDIT_REFERENCE_NOT_BOUND'],
    [{referenceDocumentId:randomUUID()},'CREDIT_REFERENCE_NOT_BOUND'],
    [{declaredAmount:'119.00',snapshotAmount:'119.00'},'OBSERVED_CREDITS_EXCEED_ORIGINAL'],
    [{declaredAmount:'-1.00',snapshotAmount:'-1.00'},'CREDIT_DECLARATION_INCONSISTENT'],
    [{declaredAmount:'1e2',snapshotAmount:'1e2'},'CREDIT_DECLARATION_INCONSISTENT'],
  ])('reports inconsistent declarations without inventing a remainder',async(patch,code)=>{
    const f=await intent();f.store.credits=[{declaredAmount:'3.00',snapshotAmount:'3.00',currency:'PEN',referenceDocumentId:f.original.id,referenceSha256:f.original.snapshotSha256,...patch}];
    const r=await f.core.readiness(f.token,'SERVICE',1,f.id);expect(r.declarations.illustrativeRemainingAmount).toBeNull();expect(r.declarations.observedCreditTotal).toBeNull();expect(r.blockers).toContain(code);
  });
  it('fails closed on more than 100 local credit declarations',async()=>{
    const f=await intent();f.store.credits=Array.from({length:101},()=>({declaredAmount:'0.01',snapshotAmount:'0.01',currency:'PEN',referenceDocumentId:f.original.id,referenceSha256:f.original.snapshotSha256}));const r=await f.core.readiness(f.token,'SERVICE',1,f.id);expect(r.declarations).toMatchObject({withinLimit:false,historyCompleteness:'NOT_VERIFIED',illustrativeRemainingAmount:null});expect(r.blockers).toContain('LOCAL_CREDIT_HISTORY_LIMIT_EXCEEDED');
  });
  it('does not assess a changed or disappeared original snapshot',async()=>{
    const f=await intent();f.store.originals.get(f.original.id)!.snapshotSha256='c'.repeat(64);await expect(f.core.readiness(f.token,'SERVICE',1,f.id)).rejects.toMatchObject({code:'ORIGINAL_REFERENCE_CHANGED'});f.store.originals.delete(f.original.id);await expect(f.core.readiness(f.token,'SERVICE',1,f.id)).rejects.toMatchObject({code:'ORIGINAL_REFERENCE_CHANGED'});
  });
  it('cancellation blocks readiness but leaves diagnostic facts and original intact',async()=>{
    const f=await intent();await f.command('CANCEL',f.id,key+'cancel','"v1"',{},'CORRECTION_REQUEST');const r=await f.core.readiness(f.token,'SERVICE',1,f.id);expect(r.requestState).toBe('CANCELLED');expect(r.blockers).toContain('REQUEST_CANCELLED');expect(f.store.originals.get(f.original.id)).toEqual(f.original);
  });
  it('revocation and foreign actor/issuer deny assessment',async()=>{
    const f=await intent();await expect(f.core.readiness(f.token,'SERVICE',2,f.id)).rejects.toMatchObject({status:404});f.store.rows.get(f.id)!.actorKey='USER:'+randomUUID();await expect(f.core.readiness(f.token,'SERVICE',1,f.id)).rejects.toMatchObject({status:404});await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());await expect(f.core.readiness(f.token,'SERVICE',1,f.id)).rejects.toMatchObject({status:401});
  });
  it('an invalid original declaration never yields a numeric capacity',async()=>{
    const f=await commercialFixture();for(const patch of [{payableAmount:'-1.00'},{payableAmount:'0.00'},{currency:'EUR'},{snapshotSha256:'forged'}])expect(assessCorrectionDeclarations({...f.original,...patch} as any,[])).toMatchObject({illustrativeRemainingAmount:null,problems:['ORIGINAL_DECLARATION_INCONSISTENT'],spendableBalance:false});
  });
});
describe('B2B-06 corrections are durable intent, never fiscal operations',()=>{
  const body=(f:any,kind='CREDIT_NOTE')=>({originalDocumentId:f.original.id,kind,reason:'Solicitud sintética de revisión',...(kind==='VOID'?{}:{proposedAmount:'118.00'}),externalReference:{namespace:'synthetic',value:'correction'}});
  it.each(['CREDIT_NOTE','DEBIT_NOTE','VOID'])('registers %s against an owned original without financial/counter effects',async kind=>{
    const f=await commercialFixture(),r=await f.command('CREATE',null,key,undefined,body(f,kind),'CORRECTION_REQUEST');
    expect(r.response).toMatchObject({state:'BLOCKED_FISCAL_EXECUTION',fiscalExecutionEnabled:false,original:{snapshotSha256:'a'.repeat(64)}});expect(r.response.blockers).toContain('TRUSTED_EVIDENCE_RESOLVER_PENDING');expect(f.store.nextFiscal).toBe(1);expect(f.store.numbers.size).toBe(0);
    expect((await f.command('CREATE',null,key,undefined,body(f,kind),'CORRECTION_REQUEST')).replayed).toBe(true);await f.command('CANCEL',r.response.id,key+'c','"v1"',{},'CORRECTION_REQUEST');expect(f.store.originals.get(f.original.id)).toEqual(f.original);
  });
  it('does not trust caller evidence or accept proposed credit over the original',async()=>{
    const f=await commercialFixture();await expect(f.command('CREATE',null,key,undefined,{...body(f),cdrVerified:true},'CORRECTION_REQUEST')).rejects.toMatchObject({status:400});
    await expect(f.command('CREATE',null,key,undefined,{...body(f),proposedAmount:'118.01'},'CORRECTION_REQUEST')).rejects.toMatchObject({status:422});
    await expect(f.command('CREATE',null,key,undefined,{...body(f,'VOID'),proposedAmount:'0.00'},'CORRECTION_REQUEST')).rejects.toMatchObject({status:400});expect(f.store.rows.size).toBe(0);
  });
  it('foreign original is hidden, even when its UUID is known',async()=>{
    const f=await commercialFixture();f.store.originals.get(f.original.id)!.binding={...invoiceBinding,seriesId:randomUUID()};await expect(f.command('CREATE',null,key,undefined,body(f),'CORRECTION_REQUEST')).rejects.toMatchObject({status:404});expect(f.store.rows.size).toBe(0);
  });
  it('fiscal execution cannot be obtained by reusing commercial commands',async()=>{
    const f=await commercialFixture(),r=await f.command('CREATE',null,key,undefined,body(f),'CORRECTION_REQUEST');for(const action of ['COMPLETE','CONVERT','PATCH'])await expect(f.command(action,r.response.id,key+action,'"v1"',{},'CORRECTION_REQUEST')).rejects.toMatchObject({code:'FISCAL_PROFILE_NOT_ENABLED'});expect(f.store.documents).toHaveLength(0);
  });
  it('USER write needs document.issue and view, while default policy remains closed',async()=>{
    const scopes=['b2b:sales-notes:write','b2b:corrections:write'],user:any={clientId:randomUUID(),clientRevision:1,oidcClientId:'synthetic',userId:randomUUID(),authRevision:1,tokenScopes:scopes,permissions:['document.view'],scope:{kind:'GLOBAL'}};
    const a=fixture({verify:async()=>structuredClone(user)},B2bEnabledIdentityScopes),c=await a.core.create('human-step-up',{label:'Synthetic commercial user',kind:'USER',oidcClientId:user.oidcClientId,scopes,bindings:[invoiceBinding]},ctx());user.clientId=c.client.id;
    for(const scope of scopes)await expect(a.core.authenticate('synthetic',[scope as any],ctx(),'USER')).rejects.toMatchObject({status:403});user.permissions.push('document.issue');expect((await a.core.authenticate('synthetic',scopes as any,ctx(),'USER')).subjectId).toBe(user.userId);
    await expect(fixture().core.create('human-step-up',{label:'No implicit commercial scopes',kind:'SERVICE',scopes,bindings:[invoiceBinding]},ctx())).rejects.toMatchObject({code:'INVALID_SCOPE'});
  });
});
