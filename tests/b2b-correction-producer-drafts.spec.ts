import {describe,it,expect,vi} from 'vitest';
import {PrismaCorrectionProducerDrafts,orderCorrectionCreditHistory} from '../services/billing-service/src/b2b/correction-producer-drafts';
import {supplementCommandFixture,supplementUuid as id} from './helpers/fiscal-supplement.fixture';
import {fiscalSnapshotSha256,buildFiscalNoteSnapshot} from '../packages/sunat-core/src/fiscal-note';
import type {B2bCorrectionCreateRequest} from '../services/billing-service/src/b2b/correction-producer';
import type {SupplementActor} from '../services/billing-service/src/application/supplement-actor';

function fixture(){
  const f=supplementCommandFixture(),binding={reference:{issuerId:99,issuerRuc:f.doc.issuer.identityNumber,environment:'BETA' as const,branchId:f.doc.branchId!,pointId:id(40),seriesId:id(41),documentType:'01' as const},noteSeriesId:id(42),noteType:'07' as const};
  const actor:SupplementActor={userId:null,b2b:{kind:'SERVICE',clientId:id(50),revision:1,subjectId:null,userAuthRevision:null},scope:{kind:'ASSIGNED',branchIds:[binding.reference.branchId],emissionPointIds:[id(40)],series:[id(41),id(42)]}};
  const request:B2bCorrectionCreateRequest={schemaVersion:'factuez.b2b.correction-create.v1',binding,originalDocumentId:f.doc.documentId,idempotencyKey:'request-synthetic-0001',externalReference:{namespace:'ERP',value:'synthetic-1'},note:f.note.adjustment,issueDate:f.note.issueDate};
  const rows:any[]=[],events:any[]=[],credits:any[]=[];
  const db:any={$queryRawUnsafe:vi.fn(async(sql:string,...args:unknown[])=>sql.includes('WHERE "operationId"')?rows.filter(r=>r.operationId===args[0]&&JSON.stringify(r.binding)===args[1]&&r.actorIdentitySha256===args[2]):rows),
    seriesCounter:{findMany:vi.fn(async()=>[{id:id(41),series:'FQ01',documentType:'INVOICE',nextNumber:2n},{id:id(42),series:'FC01',documentType:'CREDIT_NOTE',nextNumber:7n}])},
    document:{findFirst:vi.fn(async()=>({immutableSnapshot:structuredClone(f.doc)})),findMany:vi.fn(async()=>credits)},outboxEvent:{findMany:vi.fn(async()=>events)}};
  const seals=new WeakSet<object>(),evidence={original:vi.fn(async()=>{const p={evidence:structuredClone(f.acceptance),fence:{fixtureOnly:true}};seals.add(p);return p;}),ownsOriginal:(v:unknown)=>!!v&&typeof v==='object'&&seals.has(v)};
  const drafts=new PrismaCorrectionProducerDrafts(db,evidence,()=>f.context.asOf);
  return{...f,binding,actor,request,db,rows,events,credits,evidence,drafts};
}
describe('enterprise correction owner preparation',()=>{
  it('plans from owned original/series and verified owner evidence, without allocating or writing',async()=>{
    const f=fixture(),c=await f.drafts.prepare(f.request,f.actor);expect(c.payload.envelope.kind).toBe('NOTE');if(c.payload.envelope.kind!=='NOTE')throw Error();
    expect(c.payload.envelope.note.number).toBe('7');expect(c.payload.envelope.note.series).toBe('FC01');expect(c.payload.envelope.context.original).toEqual(f.doc);
    expect(c.payload.envelope.note.documentId).not.toBe(f.note.documentId);expect(c.payload.envelope.note.adjustment).toEqual(f.request.note);
    expect(c.payload.envelope.note.originalAcceptance).toEqual(f.acceptance);expect(c.payload.envelope.note.totals.payableAmount).toBe('118.00');
    expect(f.db.$queryRawUnsafe.mock.calls.every(([sql]:[string])=>sql.startsWith('SELECT '))).toBe(true);
    expect(f.db.seriesCounter.findMany.mock.calls[0][0].where.company).toEqual({active:true,ruc:f.doc.issuer.identityNumber,environment:'BETA'});
    await expect(f.drafts.operation(f.binding,c.payload.operationId,f.actor)).resolves.toBeUndefined();
    expect(f.drafts.receiptFor(c).requestSha256).toBe(fiscalSnapshotSha256(f.request));
  });
  it('has deterministic request identity but never uses a client-supplied number',async()=>{
    const f=fixture(),a=await f.drafts.prepare(f.request,f.actor),other=new PrismaCorrectionProducerDrafts(f.db,f.evidence,()=>f.context.asOf),b=await other.prepare(f.request,f.actor);
    expect(a).toEqual(b);expect(a.eventId).not.toBe(a.payload.operationId);
    const changed=structuredClone(a);changed.occurredAt='2026-10-03T19:00:00Z';expect(()=>f.drafts.receiptFor(changed)).toThrow('OWN_PREPARED_COMMAND_REQUIRED');
  });
  it('replays only an exact durable request after restarting the adapter',async()=>{
    const f=fixture(),c=await f.drafts.prepare(f.request,f.actor),receipt=f.drafts.receiptFor(c);f.rows.push({...receipt,operationId:c.payload.operationId});f.events.push({payload:c});
    const restarted=new PrismaCorrectionProducerDrafts(f.db,f.evidence,()=>f.context.asOf);expect(await restarted.replay(f.request,f.actor)).toEqual(c);
    f.db.document.findFirst.mockImplementation(()=>{throw Error('SHOULD_NOT_REPLAN');});expect(await restarted.prepare(f.request,f.actor)).toEqual(c);
    expect(restarted.receiptFor(c)).toEqual(receipt);
  });
  it.each(['idempotencyKey','externalReference','note','issueDate'] as const)('rejects conflicting durable %s without replanning',async key=>{
    const f=fixture(),c=await f.drafts.prepare(f.request,f.actor);f.rows.push({...f.drafts.receiptFor(c),operationId:c.payload.operationId});f.events.push({payload:c});
    const request=structuredClone(f.request);
    if(key==='idempotencyKey')request.idempotencyKey+='x';else if(key==='externalReference')request.externalReference.value+='x';else if(key==='issueDate')request.issueDate='2026-10-02T17:01:00Z';else request.note.reasonDescription+=' changed';
    await expect(f.drafts.replay(request,f.actor)).rejects.toMatchObject({code:'CORRECTION_REQUEST_CONFLICT'});
  });
  it('does not consider a receipt enough if its own Outbox command is missing',async()=>{
    const f=fixture(),c=await f.drafts.prepare(f.request,f.actor);f.rows.push({...f.drafts.receiptFor(c),operationId:c.payload.operationId});
    await expect(f.drafts.replay(f.request,f.actor)).rejects.toMatchObject({code:'CORRECTION_COMMAND_MISSING'});
  });
  it('denies another client and another pair even when the operation ID is known',async()=>{
    const f=fixture(),c=await f.drafts.prepare(f.request,f.actor),other=structuredClone(f.actor);other.b2b!.clientId=id(51);
    await expect(f.drafts.operation(f.binding,c.payload.operationId,other)).rejects.toMatchObject({code:'CORRECTION_OPERATION_NOT_FOUND'});
    await expect(f.drafts.operation({...f.binding,noteSeriesId:id(55)},c.payload.operationId,f.actor)).rejects.toMatchObject({code:'CORRECTION_OPERATION_NOT_FOUND'});
  });
  it('fails closed on unowned original proof',async()=>{
    const f=fixture();f.evidence.ownsOriginal=()=>false;
    await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:'VERIFIED_ORIGINAL_REQUIRED'});
  });
  it('fails closed on a proof bound to a different original',async()=>{
    const f=fixture();f.acceptance.documentId=id(88);f.evidence.original.mockImplementation(async()=>({evidence:f.acceptance,fence:{fixtureOnly:true}}));f.evidence.ownsOriginal=()=>true;
    await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:'VERIFIED_ORIGINAL_REQUIRED'});
  });
  it('fails before planning when the original is absent',async()=>{
    const f=fixture();f.db.document.findFirst.mockResolvedValue(null);await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:'CORRECTION_ORIGINAL_NOT_FOUND'});expect(f.evidence.original).not.toHaveBeenCalled();
  });
  it.each(['REJECTED','FOREIGN_POINT','FOREIGN_SERIES'] as const)('does not free or adopt %s history',async problem=>{
    const f=fixture();f.credits.push({id:f.note.documentId,seriesCounterId:problem==='FOREIGN_SERIES'?id(77):id(42),emissionPointId:problem==='FOREIGN_POINT'?id(78):id(40),immutableSnapshot:f.note,sunatStatus:problem==='REJECTED'?'REJECTED':'QUEUED'});
    await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:problem==='REJECTED'?'REJECTED_CREDIT_REQUIRES_RECONCILIATION':'CROSS_SERIES_HISTORY_PROFILE_NOT_ENABLED'});
  });
  it('requires both original and note series in the actor grant',async()=>{
    const f=fixture();f.actor.scope={kind:'ASSIGNED',branchIds:[f.binding.reference.branchId],emissionPointIds:[id(40)],series:[id(41)]};
    await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:'CORRECTION_SCOPE_DENIED'});expect(f.db.document.findFirst).not.toHaveBeenCalled();
  });
  it('rejects inactive/unavailable note series before evidence',async()=>{
    const f=fixture();f.db.seriesCounter.findMany.mockResolvedValue([]);await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:'CORRECTION_SERIES_NOT_FOUND'});expect(f.evidence.original).not.toHaveBeenCalled();
  });
  it('rejects a boleta individual profile without reading its original',async()=>{
    const f=fixture();f.request.binding.reference.documentType='03' as never;await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:'CORRECTION_PROFILE_NOT_ENABLED'});expect(f.db.document.findFirst).not.toHaveBeenCalled();
  });
  it('caps history before constructing a command',async()=>{
    const f=fixture();f.credits.push(...Array.from({length:101},()=>({})));await expect(f.drafts.prepare(f.request,f.actor)).rejects.toMatchObject({code:'CORRECTION_HISTORY_LIMIT'});
  });
  it('prepares a third valid credit with equal issue dates and reverse lexical IDs without rewriting snapshots',async()=>{
    const f=fixture(),adjustment={documentTypeCode:'07' as const,reasonCode:'07' as const,reasonDescription:'PARTIAL SYNTHETIC RETURN',lines:[{originalLineNumber:1,quantity:'0.5'}]};
    const first=buildFiscalNoteSnapshot(f.context,adjustment,{documentId:id(600),series:'FC01',number:'1',issueDate:f.note.issueDate});
    const second=buildFiscalNoteSnapshot({...f.context,creditHistory:{complete:true,entries:[{state:'RESERVED',note:first}]}},adjustment,{documentId:id(500),series:'FC01',number:'2',issueDate:f.note.issueDate});
    expect(second.documentId<first.documentId).toBe(true);
    f.credits.push(...[second,first].map(note=>({id:note.documentId,seriesCounterId:id(42),emissionPointId:id(40),immutableSnapshot:note,sunatStatus:'QUEUED'})));
    const before=structuredClone(f.credits);f.request.note=adjustment;
    const c=await f.drafts.prepare(f.request,f.actor);if(c.payload.envelope.kind!=='NOTE')throw Error();
    expect(c.payload.envelope.context.creditHistory.entries.map(e=>e.note.documentId)).toEqual([first.documentId,second.documentId]);
    expect(c.payload.envelope.note.creditHistoryIds).toEqual([first.documentId,second.documentId]);expect(c.payload.envelope.note.totals.payableAmount).toBe('59.00');expect(f.credits).toEqual(before);
  });
  it.each(['duplicate','missing','cycle','ambiguous'] as const)('rejects %s history dependencies without inventing a prefix',problem=>{
    const f=fixture(),a=structuredClone(f.note),b=structuredClone(f.note);b.documentId=id(80);b.fullNumber='FC01-2';b.number='2';
    if(problem==='duplicate')b.documentId=a.documentId;
    if(problem==='missing')a.creditHistoryIds=[id(99)];
    if(problem==='cycle'){a.creditHistoryIds=[b.documentId];b.creditHistoryIds=[a.documentId];}
    expect(()=>orderCorrectionCreditHistory([{state:'RESERVED',note:a},{state:'RESERVED',note:b}])).toThrow('CORRECTION_HISTORY_DEPENDENCY_CONFLICT');
  });
});
