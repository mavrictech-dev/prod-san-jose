import { describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import { B2bOwnerReadFrame } from '../packages/service-access/src/b2b-read-adapter';
import { b2bExtractionPersistence } from '../services/integration-export-service/src/b2b/persistence';
import { B2bExtraction } from '../services/integration-export-service/src/b2b/core';
import { b2bExtractionFixture } from './b2b-extraction.fixture';
import { documentId,secondId } from './integration-read.fixture';
import { ctx,id } from './b2b-identity.fixture';
import { fixture,input } from './b2b-identity.fixture';
import { B2bExtractionScopes } from '../packages/contracts/src/b2b-security';
describe('B2B-03 explicit reuse of persistent cuts/export/feed engines',()=>{
  it('materializes an encrypted stable cut with initial two-owner change checkpoint',async()=>{
    const f=await b2bExtractionFixture(),first=await f.core.execute(f.token,'SERVICE','documents',f.args(f.cutQuery));
    expect(first.schemaVersion).toBe('factuez.b2b.v1');expect(first.payload.page.changeCheckpoint).toBeTruthy();expect(first.payload.items[0].id).toBe(documentId);
    const second=await f.core.execute(f.token,'SERVICE','documents',f.args({...f.cutQuery,cursor:first.payload.page.nextCursor}));expect(second.payload.items[0].id).toBe(secondId);
    const record=[...f.persistence.exports.records.values()][0];expect(record.payload!.toString()).not.toContain('Cliente ficticio');expect(record.clientId).not.toBe(f.made.client.id);
    const detail=await f.core.execute(f.token,'SERVICE','detail',f.args({...f.query,snapshotId:first.payload.page.snapshotId},documentId));expect(detail.payload.detail.items).toHaveLength(1);
  });
  it('packages original XML with persistent job, manifest and exact ZIP hash; a lost response replays',async()=>{
    const f=await b2bExtractionFixture(),a=f.args(f.query,null,f.request,'synthetic_export_command_001');
    const made=await f.core.execute(f.token,'SERVICE','create',a),again=await f.core.execute(f.token,'SERVICE','create',a);expect(again.payload.id).toBe(made.payload.id);expect(f.persistence.exports.records.size).toBe(1);
    expect(await f.core.runOne()).toBe(true);const status=await f.core.execute(f.token,'SERVICE','status',f.args(f.query,made.payload.id));expect(status.payload.state).toBe('READY');
    const manifest=await f.core.execute(f.token,'SERVICE','manifest',f.args(f.query,made.payload.id));expect(manifest.payload.complete).toBe(true);expect(manifest.payload.files.some((x:any)=>x.path.endsWith('.xml'))).toBe(true);
    const zip=await f.core.execute(f.token,'SERVICE','content',f.args(f.query,made.payload.id));expect(zip.mediaType).toBe('application/zip');expect(zip.sha256).toBe(createHash('sha256').update(zip.bytes).digest('hex'));expect(zip.bytes.subarray(0,2).toString()).toBe('PK');
    expect(JSON.stringify([...f.persistence.exports.records.values()])).not.toContain(f.token);
  });
  it('reports both journal sources without Socket.io or updatedAt polling; checkpoint replay is durable',async()=>{
    const f=await b2bExtractionFixture(),cut=await f.core.execute(f.token,'SERVICE','documents',f.args(f.cutQuery)),checkpoint=cut.payload.page.changeCheckpoint;
    f.old.append('BILLING','DOCUMENT_CREATED',documentId);f.old.append('SUNAT','ARTIFACT_ADDED',documentId);
    const a=f.args({...f.query,checkpoint,limit:'1'}),first=await f.core.execute(f.token,'SERVICE','changes',a),retry=await f.core.execute(f.token,'SERVICE','changes',a);
    expect(first).toEqual(retry);expect(first.payload.items).toHaveLength(1);expect(first.payload.hasMore).toBe(true);
    const next=await f.core.execute(f.token,'SERVICE','changes',f.args({...f.query,checkpoint:first.payload.nextCheckpoint,limit:'100'}));expect(next.payload.items[0].kind).toBe('ARTIFACT_ADDED');
  });
  it('new service instance recovers a frozen page from the injected persistent owner store',async()=>{
    const f=await b2bExtractionFixture(),a=await f.core.execute(f.token,'SERVICE','documents',f.args(f.cutQuery));
    const restarted=new B2bExtraction(f.persistence,f.identity,f.billingPort,f.fiscal,f.old.now);
    const b=await restarted.execute(f.token,'SERVICE','documents',f.args({...f.cutQuery,cursor:a.payload.page.nextCursor}));expect(b.payload.items[0].id).toBe(secondId);
  });
  it('requires dedicated B2B database before attaching a worker, not the legacy export queue',async()=>{
    const pool:any={query:async()=>({rows:[{name:'integration_exports_beta'}]})};await expect(b2bExtractionPersistence(pool,Buffer.alloc(32))).rejects.toThrow('Dedicated b2b_exports_beta');
  });
  it.each(['b2b:exports:create','b2b:exports:read','b2b:changes:read'])('rejects an incomplete grant without document read: %s',async scope=>{
    const auth=fixture(null,B2bExtractionScopes);await expect(auth.core.create('human-step-up',{...input(),scopes:['b2b:context:read',scope]},ctx())).rejects.toMatchObject({code:'INVALID_SCOPE'});
  });
  it('USER actors and auth revisions produce distinct engine namespaces, even with identical grants',async()=>{
    const f=await b2bExtractionFixture(),p=await f.auth.core.authenticate(f.token,[],ctx());
    const identities=[{...p,kind:'USER' as const,subjectId:id(1),userAuthRevision:1},{...p,kind:'USER' as const,subjectId:id(2),userAuthRevision:1},{...p,kind:'USER' as const,subjectId:id(1),userAuthRevision:2}];
    const results=await Promise.all(identities.map(principal=>new B2bOwnerReadFrame({authenticate:async()=>principal},'USER').authenticate('synthetic',['integration:documents:read'])));
    expect(new Set(results.map(r=>r.clientId)).size).toBe(3);expect(results.every(r=>r.clientId!==p.clientId)).toBe(true);
  });
  it('grant revocation invalidates persistent cuts, jobs and download, not only cache population',async()=>{
    const f=await b2bExtractionFixture(),made=await f.core.execute(f.token,'SERVICE','create',f.args(f.query,null,f.request,'synthetic_export_revoke_001'));await f.core.runOne();
    await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());await expect(f.core.execute(f.token,'SERVICE','content',f.args(f.query,made.payload.id))).rejects.toMatchObject({status:401});
  });
  it('rejects unsupported sources and production before capture or packaging',async()=>{
    const f=await b2bExtractionFixture();
    await expect(f.core.execute(f.token,'SERVICE','documents',f.args({...f.cutQuery,types:'31'}))).rejects.toMatchObject({status:422});
    await expect(f.core.execute(f.token,'SERVICE','create',f.args(f.query,null,{...f.request,filters:{...f.request.filters,environment:'PRODUCTION'}},'synthetic_bad_command_001'))).rejects.toMatchObject({code:'ENVIRONMENT_NOT_ALLOWED'});
    expect(f.persistence.exports.records.size).toBe(0);expect(f.capture.capture).not.toHaveBeenCalled();
  });
  it('retention floor invalidates old change checkpoints instead of silently skipping events',async()=>{
    const f=await b2bExtractionFixture(),cut=await f.core.execute(f.token,'SERVICE','documents',f.args(f.cutQuery));f.old.append('SUNAT');f.old.journals.SUNAT.floor=1n;
    await expect(f.core.execute(f.token,'SERVICE','changes',f.args({...f.query,checkpoint:cut.payload.page.changeCheckpoint}))).rejects.toMatchObject({status:410});
  });
});
