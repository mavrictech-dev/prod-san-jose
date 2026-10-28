import {describe,it,expect,vi} from 'vitest';
import {PostgresBatchMemberOwner} from '../services/billing-service/src/b2b/batch-member-postgres';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {supplementCommandFixture,supplementUuid} from './helpers/fiscal-supplement.fixture';

function fixture(){
 const {doc}=supplementCommandFixture(),hash=fiscalSnapshotSha256(doc),member={documentId:doc.documentId,version:1,snapshotSha256:hash};
 const binding={environment:'BETA',issuerRuc:doc.issuer.identityNumber,companyId:doc.companyId,branchId:doc.branchId,pointId:supplementUuid(20),seriesId:supplementUuid(21),series:doc.series,documentType:'01'};
 const record={member,binding,snapshot:doc,acceptance:null,notDelivered:null,note:null};
 const row={record,record_sha256:fiscalSnapshotSha256(record),provenance:{signedXmlSha256:'a'.repeat(64)},current_version:1,revision:1,binding,history_revision:1};
 let selected:any[]=[{version:1}],stored:any=row;
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  if(sql.includes('WHERE document_id=$1 AND snapshot_sha256=$2'))return {rows:selected,rowCount:selected.length};
  if(sql.includes('FROM b2b_batch_member_version v JOIN'))return {rows:stored?[stored]:[],rowCount:stored?1:0};
  if(sql.includes("record->'acceptance'"))return {rows:[],rowCount:0};
  return {rows:[],rowCount:0};
 });
 const release=vi.fn(),pool={connect:vi.fn(async()=>({query,release}))};
 const owner=new PostgresBatchMemberOwner(pool as any,{} as any,{} as any,{} as any);
 return {member,row,owner,query,release,pool,set rows(value:any[]){selected=value;},set stored(value:any){stored=value;}};
}
describe('exact private batch version lookup',()=>{
 it('resolves one matching version under the owner transaction and checks the stored record',async()=>{
  const f=fixture();expect(await f.owner.resolve(f.member.documentId,f.member.snapshotSha256)).toEqual(f.member);
  const sql=f.query.mock.calls.map(([q])=>q);expect(sql[0]).toContain('pg_advisory_lock');expect(sql).toContain('COMMIT');expect(sql.at(-1)).toContain('pg_advisory_unlock');expect(f.release).toHaveBeenCalledOnce();
 });
 it('returns no version for an absent exact match',async()=>{const f=fixture();f.rows=[];expect(await f.owner.resolve(f.member.documentId,f.member.snapshotSha256)).toBeNull();});
 it('rejects ambiguity instead of assuming the most recent signed or accepted version',async()=>{
  const f=fixture();f.rows=[{version:1},{version:2}];await expect(f.owner.resolve(f.member.documentId,f.member.snapshotSha256)).rejects.toMatchObject({code:'BATCH_MEMBER_CHANGED'});
  expect(f.query.mock.calls.some(([q])=>q==='ROLLBACK')).toBe(true);
 });
 it.each(['corrupt','wrong-version','missing-record'] as const)('rejects %s data',async kind=>{
  const f=fixture();if(kind==='corrupt')f.row.record_sha256='f'.repeat(64);if(kind==='wrong-version')f.rows=[{version:2}];if(kind==='missing-record')f.stored=null;
  await expect(f.owner.resolve(f.member.documentId,f.member.snapshotSha256)).rejects.toBeDefined();
 });
 it('rejects malformed identifiers before connecting',()=>{
  const f=fixture();expect(()=>f.owner.resolve('not-a-uuid',f.member.snapshotSha256)).toThrow();expect(f.pool.connect).not.toHaveBeenCalled();
 });
});
