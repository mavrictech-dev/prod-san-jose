import 'reflect-metadata';
import {afterEach,beforeAll,describe,it,expect,vi} from 'vitest';
import {NestFactory} from '../services/sunat-service/node_modules/@nestjs/core';
import {BatchMemberEvidenceModule} from '../services/sunat-service/src/b2b/batch-member-evidence-http';
import {HttpBatchMemberEvidence} from '../services/billing-service/src/b2b/batch-member-evidence-http';
import {PostgresBatchMemberEvidenceRepository} from '../services/sunat-service/src/application/batch-member-evidence.repository';
import {batchMemberTestPki,batchMemberEvidenceFixture} from './helpers/batch-member-evidence.fixture';
import {fiscalSnapshotSha256 as hash} from '../packages/sunat-core/src/fiscal-note';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
let pki:ReturnType<typeof batchMemberTestPki>,tls:ReturnType<typeof b2bCertificates>;const cleanup:(()=>Promise<unknown>)[]=[];
beforeAll(()=>{pki=batchMemberTestPki();tls=b2bCertificates();},60000);
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(type:'01'|'03'='01'){
 const f=await batchMemberEvidenceFixture(pki,type),app=await NestFactory.create(BatchMemberEvidenceModule.isolated(f.adapter,{billing:[fingerprint(tls.resource)]}),
  {logger:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
 await app.listen(0,'127.0.0.1');cleanup.push(()=>app.close());
 const options={enabled:true,origin:'https://127.0.0.1:'+app.getHttpServer().address().port,sunatPeerSha256:fingerprint(tls.server),tls:{ca:tls.ca,cert:tls.resource,key:tls.key}};
 return {...f,options,client:new HttpBatchMemberEvidence(options)};
}
describe('private batch evidence transport: real XML/CDR signatures with fictitious trust policy and storage',()=>{
 it.each(['01','03'] as const)('verifies exact %s owner XML and CDR before returning a bound fresh result',async type=>{
  const f=await fixture(type),result=await f.client.verifySignedVersion('opaque-member-version-1',f.asOf);
  expect(result.snapshot.documentId).toBe(f.record.member.documentId);expect(result.acceptance?.responseCode).toBe('0');
  expect(result.provenance.catalogueSha256).toBe(hash([]));expect(result.provenance.signedXmlSha256).toBe(f.record.signedXml.sha256);expect(f.owner.load.mock.calls.length).toBeGreaterThan(2);
 });
 it('rejects an unauthorized certificate, a mismatched server pin and disabled clients',async()=>{
  const f=await fixture();
  for(const patch of [{tls:{...f.options.tls,cert:tls.edge}},{sunatPeerSha256:fingerprint(tls.other)},{enabled:false}]){
   await expect(new HttpBatchMemberEvidence({...f.options,...patch}).verifySignedVersion('opaque-member-version-1',f.asOf)).rejects.toThrow('BATCH_EVIDENCE_HTTP_UNAVAILABLE');
  }
 });
 it('rejects corrupted original bytes and never turns storage metadata into successful acceptance',async()=>{
  const f=await fixture(),bytes=f.blobs.get(f.record.signedXml.id)!;f.blobs.set(f.record.signedXml.id,Buffer.from(bytes.toString().replace('Invoice','UntrustedInvoice')));
  await expect(f.client.verifySignedVersion('opaque-member-version-1',f.asOf)).rejects.toThrow('BATCH_EVIDENCE_HTTP_UNAVAILABLE');
 });
 it('does not allow stale requests, filesystem handles or caller-supplied XML evidence',async()=>{
  const f=await fixture(),before=f.owner.load.mock.calls.length;
  for(const h of ['../outside.xml','https://external.invalid/xml',''])await expect(f.client.verifySignedVersion(h,f.asOf)).rejects.toThrow();
  await expect(f.client.verifySignedVersion('opaque-member-version-1',new Date(Date.now()-31000).toISOString())).rejects.toThrow();
  expect(f.owner.load.mock.calls).toHaveLength(before);
 });
 it('resolves only the exact persisted handle and fails explicitly if historical versions do not exist',async()=>{
  const query=vi.fn(async()=>({rows:[],rowCount:0})),release=vi.fn(),repo=new PostgresBatchMemberEvidenceRepository({connect:async()=>({query,release})});
  await expect(repo.load('opaque-version-missing')).rejects.toMatchObject({code:'BATCH_EVIDENCE_VERSION_MISSING'});
  expect(query.mock.calls[0]).toEqual(['SELECT owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256 FROM b2b_sunat_batch_member_evidence_version WHERE owner_handle=$1',['opaque-version-missing']]);
  expect(release).toHaveBeenCalledOnce();
 });
 it('does not relabel a missing note credit catalogue as complete through the new ledger',async()=>{
  const f=await fixture(),record=structuredClone(f.record);(record.snapshot as any).documentTypeCode='07';
  const payload={source:'OWNED',record,individual:null,summary:null},row={owner_handle:'opaque-note',document_id:record.member.documentId,version:record.member.version,snapshot_sha256:record.member.snapshotSha256,payload,payload_sha256:hash(payload)};
  const repo=new PostgresBatchMemberEvidenceRepository({connect:async()=>({query:async()=>({rows:[row],rowCount:1}),release:()=>{}})});
  await expect(repo.load('opaque-note')).rejects.toMatchObject({code:'BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING'});
 });
});
