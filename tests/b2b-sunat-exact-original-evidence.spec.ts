import {describe,it,expect,vi} from 'vitest';
import {fiscalSnapshotSha256 as hash} from '../packages/sunat-core/src/fiscal-note';
import {PostgresBatchMemberEvidenceRepository} from '../services/sunat-service/src/application/batch-member-evidence.repository';
import {PersistentBatchMemberEvidence,createPrismaBatchMemberLedgerReader} from '../services/sunat-service/src/b2b/batch-member-evidence-assembly';

const id='11111111-1111-4111-8111-111111111111';
function row(version=1,type='01'){
 const snapshot={documentId:id,documentTypeCode:type,value:`synthetic-${version}`};
 const member={documentId:id,version,snapshotSha256:hash(snapshot)};
 const record={member,snapshot,noteContext:null,ownerOriginalVersion:null,acceptance:null};
 const payload={source:'OWNED',record,individual:null,summary:null};
 return {owner_handle:`original-${version}`,document_id:id,version,snapshot_sha256:member.snapshotSha256,payload,payload_sha256:hash(payload)};
}
function setup(rows:any[]){
 const release=vi.fn();
 const query=vi.fn(async(sql:string,values:unknown[]=[])=>({rows:rows.filter(r=>r.document_id===values[0]&&r.version===values[1]&&r.snapshot_sha256===values[2]),rowCount:null}));
 return {query,release,repo:new PostgresBatchMemberEvidenceRepository({connect:async()=>({query,release})})};
}
describe('private exact original evidence lookup, synthetic storage',()=>{
 it('resolves historical versions by all three fields, never latest',async()=>{
  const a=row(1),b=row(2),f=setup([a,b]);
  await expect(f.repo.resolveHandle(a.payload.record.member)).resolves.toBe('original-1');
  await expect(f.repo.resolveHandle(b.payload.record.member)).resolves.toBe('original-2');
  expect(f.query.mock.calls[0][0]).toMatch(/WHERE document_id=\$1 AND version=\$2 AND snapshot_sha256=\$3$/);
  expect(f.query.mock.calls[0][1]).toEqual([id,1,a.snapshot_sha256]);
  await expect(f.repo.resolveHandle({...a.payload.record.member,snapshotSha256:b.snapshot_sha256})).rejects.toMatchObject({code:'BATCH_EVIDENCE_VERSION_MISSING'});
  await expect(f.repo.resolveHandle({...a.payload.record.member,version:3})).rejects.toMatchObject({code:'BATCH_EVIDENCE_VERSION_MISSING'});
  expect(f.release).toHaveBeenCalledTimes(4);
 });
 it('rejects invalid references before connecting',async()=>{
  const f=setup([]),ref=row().payload.record.member;
  for(const input of [{...ref,extra:true},{...ref,version:0},{...ref,documentId:'bad'},{...ref,snapshotSha256:'A'.repeat(64)}])
   await expect(f.repo.resolveHandle(input)).rejects.toMatchObject({code:'BATCH_EVIDENCE_OWNER_INVALID'});
  expect(f.query).not.toHaveBeenCalled();
 });
 it('rejects damaged payload, mismatched content even with refreshed payload hash, and duplicates',async()=>{
  for(const mode of ['payload','content','duplicates','row'] as const){
   const a=row();const ref={...a.payload.record.member};
   if(mode==='payload')a.payload_sha256='0'.repeat(64);
   if(mode==='content'){a.payload.record.snapshot.value='changed';a.payload_sha256=hash(a.payload);}
   const f=setup(mode==='duplicates'?[a,a]:[a]);
   if(mode==='row')f.query.mockImplementation(async()=>({rows:[{...a,version:2}],rowCount:1}));
   await expect(f.repo.resolveHandle(ref)).rejects.toMatchObject({code:'BATCH_EVIDENCE_OWNER_INVALID'});
   expect(f.release).toHaveBeenCalledOnce();
  }
 });
 it.each(['07','08'])('keeps the missing-history guard for %s',async type=>{
  const a=row(1,type),f=setup([a]);
  await expect(f.repo.resolveHandle(a.payload.record.member)).rejects.toMatchObject({code:'BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING'});
 });
 it('exposes the read-only Prisma bridge without asserting acceptance',async()=>{
  const a=row(),query=vi.fn(async()=>[a]);
  const reader=createPrismaBatchMemberLedgerReader({$queryRawUnsafe:query} as any,{} as any);
  await expect(reader.resolveHandle(a.payload.record.member)).resolves.toBe(a.owner_handle);
  expect(query).toHaveBeenCalledOnce();expect(query.mock.calls[0][0]).toMatch(/^SELECT .*document_id=\$1 AND version=\$2 AND snapshot_sha256=\$3$/);
 });
 it('rejects a changed or removed version after signature verification',async()=>{
  for(const changed of ['different','missing']){
   const ref=row().payload.record.member;
   const resolveHandle=vi.fn().mockResolvedValueOnce('original-1');
   if(changed==='different')resolveHandle.mockResolvedValueOnce('original-2');
   else resolveHandle.mockRejectedValueOnce(Object.assign(new Error('BATCH_EVIDENCE_VERSION_MISSING'),{code:'BATCH_EVIDENCE_VERSION_MISSING'}));
   const reader=new PersistentBatchMemberEvidence({resolveHandle} as any,{} as any);
   vi.spyOn(reader,'verifySignedVersion').mockResolvedValue({} as any);
   await expect(reader.verifyExactVersion(ref,'2026-10-27T00:00:00Z')).rejects.toMatchObject({code:changed==='different'?'BATCH_EVIDENCE_OWNER_INVALID':'BATCH_EVIDENCE_VERSION_MISSING'});
   expect(resolveHandle).toHaveBeenCalledTimes(2);
  }
 });
 it('maps missing storage and other failures without exposing database details',async()=>{
  for(const [error,code] of [[{code:'42P01'},'BATCH_EVIDENCE_VERSION_MISSING'],[new Error('private'),'BATCH_EVIDENCE_STORAGE_UNAVAILABLE']] as const){
   const release=vi.fn(),repo=new PostgresBatchMemberEvidenceRepository({connect:async()=>({query:async()=>{throw error;},release})});
   await expect(repo.resolveHandle(row().payload.record.member)).rejects.toMatchObject({code,message:code});expect(release).toHaveBeenCalledOnce();
  }
 });
});
