import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {supplementActor,supplementActorIdentity} from '../services/billing-service/src/application/supplement-actor';
import {SyntheticCorrectionReservations} from '../services/billing-service/src/application/synthetic-correction-reservations';
import {BetaSupplementCommandRepository} from '../services/billing-service/src/application/beta-supplement-command.repository';
import {buildFiscalNoteSnapshot,fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {buildFiscalSupplementCommand} from '../packages/sunat-core/src/fiscal-supplement-command';
import {supplementCommandFixture,supplementUuid as id} from './helpers/fiscal-supplement.fixture';
const scope=()=>({kind:'ASSIGNED' as const,branchIds:[id(2)],emissionPointIds:[id(20)],series:[id(21),id(22)]});
const service=()=>({userId:null,scope:scope(),b2b:{kind:'SERVICE' as const,clientId:id(30),revision:1,subjectId:null,userAuthRevision:null}});
const user=()=>({userId:id(40),scope:scope(),b2b:{kind:'USER' as const,clientId:id(30),revision:1,subjectId:id(40),userAuthRevision:1}});
function command(){const f=supplementCommandFixture();f.doc.issuer.identityNumber='20000000001';f.doc.customer.identityNumber='20000000001';
  const context={...f.context,original:f.doc,acceptance:{...f.acceptance,issuerRuc:'20000000001',snapshotSha256:fiscalSnapshotSha256(f.doc)}};
  const note=buildFiscalNoteSnapshot(context,{documentTypeCode:'07',reasonCode:'07',reasonDescription:'SYNTHETIC ONLY',lines:[{originalLineNumber:1,quantity:'1'}]},
    {documentId:id(50),series:'FC01',number:'1',issueDate:f.note.issueDate});return buildFiscalSupplementCommand({kind:'NOTE',note,context},{eventId:id(51),correlationId:id(52),occurredAt:context.asOf});}
describe('typed supplement actor representation, not authentication',()=>{
  it.each([()=>({userId:id(40),scope:{kind:'GLOBAL'}}),service,user])('keeps genuine legacy/USER/SERVICE attribution',make=>{
    const a=make(),copy=supplementActor(a);expect(copy).toEqual(a);expect(copy).not.toBe(a);if(copy.b2b?.kind==='SERVICE')expect(copy.userId).toBeNull();
  });
  it.each([
    ()=>({...service(),userId:id(40)}),()=>({...user(),userId:null}),()=>({...user(),b2b:{...user().b2b,subjectId:id(41)}}),
    ()=>({...service(),b2b:{...service().b2b,revision:0}}),()=>({...user(),b2b:{...user().b2b,userAuthRevision:-1}}),
    ()=>({...service(),scope:{kind:'GLOBAL'}}),()=>({...service(),password:'DO_NOT_STORE'}),()=>({...service(),b2b:{...service().b2b,token:'DO_NOT_STORE'}}),
    ()=>({userId:null,scope:scope()}),()=>({...service(),b2b:null}),()=>({...service(),scope:{kind:'ASSIGNED'}}),
  ])('rejects fabricated or inconsistent provenance before any database call',make=>{expect(()=>supplementActor(make())).toThrow();});
  it('rejects accessors/proxies without executing callbacks',()=>{
    let calls=0;const a=service();Object.defineProperty(a,'scope',{get(){calls++;throw new Error('FORBIDDEN');}});expect(()=>supplementActor(a)).toThrow();
    const proxy=new Proxy(service(),{get(){calls++;throw new Error('FORBIDDEN');}});expect(()=>supplementActor(proxy)).toThrow();expect(calls).toBe(0);
  });
  it('stable actor identity does not retain scopes, secrets or token revision',()=>{
    expect(supplementActorIdentity(service())).toEqual({kind:'SERVICE',clientId:id(30),subjectId:null});expect(supplementActorIdentity(user())).toEqual({kind:'USER',clientId:id(30),subjectId:id(40)});
  });
});
describe('atomic correction rehearsal remains isolated and fail-closed',()=>{
  function setup(name='not_allowed'){const owner={reserveWithinTransaction:vi.fn()},query=vi.fn(async()=>[{name}]),database={$transaction:vi.fn(async(work:any)=>work({$queryRawUnsafe:query}))},authority={current:vi.fn(async(_command:any)=>service())};return {owner,query,database,authority,core:new SyntheticCorrectionReservations(database as never,owner,authority)};}
  it('rejects any non-synthetic database after metadata only, before fiscal or hold writes',async()=>{
    const f=setup();await expect(f.core.reserve(command())).rejects.toMatchObject({code:'SYNTHETIC_DATABASE_REQUIRED'});expect(f.query).toHaveBeenCalledExactlyOnceWith('SELECT current_database() AS name');expect(f.owner.reserveWithinTransaction).not.toHaveBeenCalled();
  });
  it('never accepts a real-format issuer fixture outside its deliberately invented RUC profile',async()=>{
    const f=setup();await expect(f.core.reserve(supplementCommandFixture().command)).rejects.toMatchObject({code:'SYNTHETIC_NOTE_ONLY'});expect(f.database.$transaction).not.toHaveBeenCalled();
  });
  it('invalid command/actor cannot reach storage',async()=>{
    const f=setup();await expect(f.core.reserve({})).rejects.toMatchObject({code:'INVALID_COMMAND_OR_AUTHORITY'});f.authority.current.mockResolvedValue({...service(),userId:id(99)} as any);await expect(f.core.reserve(command())).rejects.toMatchObject({code:'INVALID_COMMAND_OR_AUTHORITY'});expect(f.database.$transaction).not.toHaveBeenCalled();
  });
  it('authority ports cannot mutate a detached command and invalidate the financial receipt',async()=>{
    const f=setup();f.authority.current.mockImplementation(async(c:any)=>{expect(Object.isFrozen(c)).toBe(true);expect(Object.isFrozen(c.payload.envelope.note.lines)).toBe(true);c.payload.issuerRuc='FORGED';return service();});
    await expect(f.core.reserve(command())).rejects.toMatchObject({code:'INVALID_COMMAND_OR_AUTHORITY'});expect(f.database.$transaction).not.toHaveBeenCalled();
  });
  it('mid-request permission or revision changes abort before the owner writes',async()=>{
    const f=setup('b2b_corrections_synthetic');f.authority.current.mockResolvedValueOnce(service()).mockResolvedValue({...service(),b2b:{...service().b2b,revision:2}});await expect(f.core.reserve(command())).rejects.toMatchObject({code:'AUTHORITY_CHANGED'});expect(f.owner.reserveWithinTransaction).not.toHaveBeenCalled();
  });
  it('serialization retries are bounded and reuse the detached command',async()=>{
    const f=setup();f.database.$transaction.mockRejectedValue({code:'P2034'});await expect(f.core.reserve(command())).rejects.toMatchObject({code:'CANDIDATE_TRANSACTION_FAILED'});expect(f.database.$transaction).toHaveBeenCalledTimes(3);
  });
  it('same-transaction repository port rejects malformed input without nesting a transaction',async()=>{
    const start=vi.fn(),owner=new BetaSupplementCommandRepository({$transaction:start} as never);await expect(owner.reserveWithinTransaction({} as never,{},service())).rejects.toThrow();expect(start).not.toHaveBeenCalled();
  });
  it('keeps service activation and public deployment closed; receipts cannot release or rewrite',()=>{
    const read=(p:string)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
    expect(read('services/billing-service/src/application/beta-supplement-command.service.ts')).toContain('assertBillingSupplementActivation();');expect(read('services/billing-service/src/application/financial-ledger-candidate.service.ts')).toContain('assertFinancialLedgerCandidateActivation();');
    expect(read('services/billing-service/src/app.module.ts')).not.toContain('SyntheticCorrectionReservations');expect(read('infra/kong/kong.stage2.qa.yml')).not.toContain('/b2b/v1');
    const ddl=read('services/billing-service/b2b-correction-holds-schema.candidate.sql');expect(ddl).toContain('BEFORE UPDATE OR DELETE');expect(ddl).toContain('NEW."creditHeld"<OLD."creditHeld"');expect(ddl).not.toMatch(/TRUNCATE|ALTER TABLE|UPDATE "Document"|UPDATE "SeriesCounter"/);
  });
});
