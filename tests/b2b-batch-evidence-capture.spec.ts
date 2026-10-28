import {beforeAll,describe,expect,it,vi} from 'vitest';
import {createBatchMemberEvidenceProducer,PostgresBatchMemberEvidenceRepository} from '../services/sunat-service/src/application/batch-member-evidence.repository';
import {batchMemberEvidenceFixture,batchMemberTestPki} from './helpers/batch-member-evidence.fixture';

let pki:ReturnType<typeof batchMemberTestPki>;
beforeAll(()=>{pki=batchMemberTestPki();},60000);
/** Real synthetic XMLDSig and ZIP; SQL/owner transport simulated explicitly.
 * The trust policy/CRL fixture is simulated, no external fiscal assertion. */
async function setup(){
 const f=await batchMemberEvidenceFixture(pki,'01',{unreported:true}),record=f.record;
 const state={stored:null as any,pending:null as any,inserted:0,commits:0,rollbacks:0,changed:false};
 const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
  if(sql==='BEGIN')return {rows:[],rowCount:0};
  if(sql==='COMMIT'){state.commits++;if(state.pending)state.stored=state.pending;state.pending=null;return {rows:[],rowCount:0};}
  if(sql==='ROLLBACK'){state.rollbacks++;state.pending=null;return {rows:[],rowCount:0};}
  if(sql.startsWith('INSERT INTO b2b_sunat_batch_member_evidence_version')){
   if(state.stored)return {rows:[],rowCount:0};
   state.inserted++;state.pending={owner_handle:values[0],document_id:values[1],version:values[2],snapshot_sha256:values[3],payload:JSON.parse(values[4] as string),payload_sha256:values[5]};
   return {rows:[{owner_handle:values[0]}],rowCount:1};
  }
  if(sql.includes('WHERE document_id=$1 AND version=$2'))return {rows:state.stored?[state.stored]:[],rowCount:state.stored?1:0};
  if(sql.includes('WHERE owner_handle=$1'))return {rows:state.stored?.owner_handle===values[0]?[state.stored]:[],rowCount:state.stored?.owner_handle===values[0]?1:0};
  throw Error('UNEXPECTED_SYNTHETIC_SQL');
 });
 const release=vi.fn(),pool={connect:vi.fn(async()=>({query,release}))};
 const findFirst=vi.fn(async()=>({immutablePayload:record.snapshot,documentId:record.member.documentId,documentType:record.binding.documentType,
  series:record.binding.series,number:record.snapshot.number,digestValue:state.changed?'tampered':record.digestValue,
  artifacts:[{...record.signedXml,kind:'SIGNED_XML'},{...record.requestZip,kind:'SUBMISSION_ZIP'}]}));
 const db={fiscalDocument:{findFirst}},crypto={artifacts:f.artifacts,certificates:f.certificates,trust:f.trust,cdr:pki.cdrVerifier};
 const producer=createBatchMemberEvidenceProducer({...crypto,owner:f.owner,pool,db:db as any});
 return {...f,state,query,release,pool,findFirst,producer,repository:new PostgresBatchMemberEvidenceRepository(pool)};
}
describe('original signed evidence capture with synthetic owner and SQL',()=>{
 it('verifies real XML signatures and owner before persisting; replay preserves the exact handle',async()=>{
  const f=await setup(),first=await f.producer.capture('opaque-member-version-1',f.asOf),second=await f.producer.capture('opaque-member-version-1',f.asOf);
  expect(second).toEqual(first);expect(first.member).toEqual(f.record.member);expect(f.state.inserted).toBe(1);expect(f.state.commits).toBe(2);
  expect((await f.repository.load(first.ownerHandle)).record.member).toEqual(f.record.member);
  expect(f.findFirst.mock.calls.length).toBeGreaterThanOrEqual(4);expect(f.owner.load.mock.calls.length).toBeGreaterThanOrEqual(6);
 });
 it('accepts the same immutable artifacts in a different database row order',async()=>{
  const f=await setup(),original=f.findFirst.getMockImplementation()!;let reads=0;
  f.findFirst.mockImplementation(async()=>{const row=await original();if(++reads%2===0)row.artifacts.reverse();return row;});
  await expect(f.producer.capture('opaque-member-version-1',f.asOf)).resolves.toMatchObject({member:f.record.member});
  expect(f.state.inserted).toBe(1);expect(f.state.commits).toBe(1);
 });
 it('rejects tampered signed XML before any insertion',async()=>{
  const f=await setup();f.blobs.set(f.record.signedXml.id,Buffer.from('altered synthetic XML'));
  await expect(f.producer.capture('opaque-member-version-1',f.asOf)).rejects.toBeDefined();expect(f.state.inserted).toBe(0);expect(f.pool.connect).not.toHaveBeenCalled();
 });
 it('rejects changed owner and incomplete note history without capturing them',async()=>{
  const f=await setup();f.state.changed=true;
  await expect(f.producer.capture('opaque-member-version-1',f.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_VERSION_MISSING'});expect(f.state.inserted).toBe(0);
  const n=await batchMemberEvidenceFixture(pki,'07',{unreported:true});
  const fake=createBatchMemberEvidenceProducer({artifacts:n.artifacts,certificates:n.certificates,trust:n.trust,cdr:pki.cdrVerifier,owner:n.owner,pool:f.pool,db:{} as any});
  await expect(fake.capture('opaque-member-version-1',n.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING'});expect(f.state.inserted).toBe(0);
 });
 it('rolls back when the owner changes after insertion but before commit',async()=>{
  const f=await setup(),original=f.findFirst.getMockImplementation()!;let reads=0;
  f.findFirst.mockImplementation(async()=>{if(++reads===2)f.state.changed=true;return original();});
  await expect(f.producer.capture('opaque-member-version-1',f.asOf)).rejects.toBeDefined();
  expect(f.state.inserted).toBe(1);expect(f.state.rollbacks).toBe(1);expect(f.state.commits).toBe(0);expect(f.state.stored).toBeNull();
 });
});
