import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {PrismaCorrectionEvidenceScope,BillingCorrectionEvidenceAuthority} from '../services/billing-service/src/b2b/correction-evidence-authority';
import {correctionEvidenceRequest,verifyCorrectionEvidenceResponse} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {supplementCommandFixture,supplementUuid as id} from './helpers/fiscal-supplement.fixture';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {BillingCorrectionEvidenceCommandReader,createBillingCorrectionEvidencePorts} from '../services/billing-service/src/b2b/correction-evidence-assembly';
const NOW='2026-10-04T18:00:00.000Z';
function fixture(action:'ORIGINAL'|'PREREQUISITES'|'OUTCOME'='ORIGINAL'){
  const data=supplementCommandFixture(),r={issuerId:data.doc.companyId!,issuerRuc:data.doc.issuer.identityNumber,branchId:data.doc.branchId!,pointId:id(30),seriesId:id(31),documentType:'01' as const,environment:'BETA' as const},
    binding={reference:r,noteSeriesId:id(32),noteType:'07' as const};
  const request=correctionEvidenceRequest({schemaVersion:'factuez.b2b.correction-evidence-request.v1',requestId:id(100),kind:'SERVICE',action,binding,asOf:NOW,payload:action==='ORIGINAL'?data.doc:data.command});
  const actor={userId:null,scope:{kind:'ASSIGNED' as const,branchIds:[r.branchId],emissionPointIds:[r.pointId],series:[r.seriesId,binding.noteSeriesId]},
    b2b:{kind:'SERVICE' as const,clientId:id(99),revision:1,subjectId:null,userAuthRevision:null}};
  const rows=[{id:r.seriesId,series:data.doc.series,documentType:'INVOICE',emissionPoint:{code:'0000'}},
    {id:binding.noteSeriesId,series:data.note.series,documentType:'CREDIT_NOTE',emissionPoint:{code:'0000'}}];
  const own=(snapshot:any)=>({id:snapshot.documentId,type:snapshot.documentTypeCode==='01'?'INVOICE':'CREDIT_NOTE',series:snapshot.series,number:BigInt(snapshot.number),fullNumber:snapshot.fullNumber,immutableSnapshot:snapshot,updatedAt:new Date(NOW)});
  const db={seriesCounter:{findMany:vi.fn(async()=>structuredClone(rows))},document:{findFirst:vi.fn(async(query:any)=>structuredClone(own(query.where.id===data.doc.documentId?data.doc:data.note)))},
    outboxEvent:{findMany:vi.fn(async()=>[{id:data.command.eventId,payload:structuredClone(data.command)}])}};
  const scope=new PrismaCorrectionEvidenceScope(db as never),authority={current:vi.fn(async()=>({actor:structuredClone(actor),clientRevision:1,grantRevision:1,candidateOnly:true as const,fiscalExecutionEnabled:false as const}))};
  const core=new BillingCorrectionEvidenceAuthority(authority,scope,()=>NOW);
  return{data,r,binding,request,actor,rows,db,scope,authority,core,run:()=>scope.inspect(request,actor)};
}
describe('Billing correction evidence scope, synthetic query results only',()=>{
  it.each(['ORIGINAL','PREREQUISITES','OUTCOME'] as const)('binds %s to the own active tuple, snapshots and exact command',async action=>{
    const f=fixture(action);expect(await f.run()).toMatch(/^[a-f0-9]{64}$/);
    expect(f.db.seriesCounter.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({companyId:f.r.issuerId,emissionPointId:f.r.pointId,active:true})}));
    expect(f.db.document.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({companyId:f.r.issuerId,emissionPointId:f.r.pointId,status:'ISSUED'})}));
    expect(f.db.outboxEvent.findMany).toHaveBeenCalledTimes(action==='OUTCOME'?1:0);
    expect(JSON.stringify(f.db.seriesCounter.findMany.mock.calls)).not.toMatch(/password|certificate|secret/i);
  });
  it.each(['missing','wrong-type','wrong-family','inactive-point'] as const)('rejects invalid canonical series: %s',async mode=>{
    const f=fixture();if(mode==='missing'||mode==='inactive-point')f.db.seriesCounter.findMany.mockResolvedValueOnce([]);
    if(mode==='wrong-type')f.rows[1].documentType='INVOICE';if(mode==='wrong-family')f.rows[1].series='BC01';
    await expect(f.run()).rejects.toMatchObject({status:404});expect(f.db.document.findFirst).not.toHaveBeenCalled();
  });
  it.each(['snapshot','type','number','series','fullNumber','missing'] as const)('fails closed for incoherent own document: %s',async mode=>{
    const f=fixture(),row=await f.db.document.findFirst({where:{id:f.data.doc.documentId}});f.db.document.findFirst.mockClear();
    if(mode==='snapshot')row.immutableSnapshot.customer.legalName='DIFFERENT';if(mode==='type')row.type='CREDIT_NOTE';if(mode==='number')row.number=100n;if(mode==='series')row.series='F999';if(mode==='fullNumber')row.fullNumber='F999-100';
    f.db.document.findFirst.mockResolvedValueOnce(mode==='missing'?null as never:row);await expect(f.run()).rejects.toMatchObject({status:404});
  });
  it('does not combine individually granted IDs into another point/series scope',async()=>{
    const f=fixture();f.actor.scope.series=[];await expect(f.run()).rejects.toMatchObject({status:404});expect(f.db.document.findFirst).not.toHaveBeenCalled();
  });
  it.each(['missing','duplicate','id','payload'] as const)('outcome requires exact own persisted command: %s',async mode=>{
    const f=fixture('OUTCOME'),rows=await f.db.outboxEvent.findMany();f.db.outboxEvent.findMany.mockClear();
    if(mode==='id')rows[0].id=id(901);if(mode==='payload')rows[0].payload.correlationId=id(902);
    f.db.outboxEvent.findMany.mockResolvedValueOnce(mode==='missing'?[]:mode==='duplicate'?[...rows,...rows]:rows);
    await expect(f.run()).rejects.toMatchObject({status:404});
  });
  it('authority response contains no snapshots or actor, rechecks twice and is bound to nonce',async()=>{
    const f=fixture(),response=await f.core.authorize('synthetic-token',f.request),checked=verifyCorrectionEvidenceResponse(response,f.request,NOW);
    expect(checked.result).toEqual({authorized:true});expect(f.authority.current).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response)).not.toMatch(/SINTETICO|synthetic-token|immutableSnapshot|subjectId/);
  });
  it.each(['revoked','revision','own-row'] as const)('revocation or owner change before reply blocks authority: %s',async mode=>{
    const f=fixture(),first=await f.authority.current();f.authority.current.mockClear();
    if(mode==='revoked')f.authority.current.mockRejectedValueOnce(new Error('REVOKED'));
    if(mode==='revision')f.authority.current.mockResolvedValueOnce(first).mockResolvedValue({...first,grantRevision:2});
    if(mode==='own-row')f.db.document.findFirst.mockResolvedValueOnce({...await f.db.document.findFirst({where:{id:f.data.doc.documentId}}),updatedAt:new Date('2026-10-04T17:59:00Z')});
    await expect(f.core.authorize('synthetic-token',f.request)).rejects.toThrow();
  });
  it('rejects expired requests before authentication or business reads',async()=>{
    const f=fixture();await expect(f.core.authorize('synthetic-token',{...f.request,asOf:'2026-10-04T17:59:00Z'})).rejects.toMatchObject({code:'EVIDENCE_REQUEST_EXPIRED'});expect(f.authority.current).not.toHaveBeenCalled();
  });
  it('grant revision participates in the authority fence even without actor changes',async()=>{
    const f=fixture(),a=await f.core.authorize('synthetic-token',f.request),normal=await f.authority.current();f.authority.current.mockResolvedValue({...normal,grantRevision:2});
    const b=await f.core.authorize('synthetic-token',f.request);expect(a.authoritySha256).not.toBe(b.authoritySha256);expect(fiscalSnapshotSha256(f.request.payload)).toBe(fiscalSnapshotSha256(f.data.doc));
  });
});

describe('Billing-owned command reader and private evidence assembly',()=>{
  function reader(){const f=fixture('OUTCOME'),token=vi.fn(async()=> 'synthetic-token'),core=new BillingCorrectionEvidenceCommandReader(f.db as never,f.authority,token,'SERVICE',f.binding,()=>NOW);return{...f,token,reader:core};}
  it('reads only its RUC/company operation after authentication and rechecks before return',async()=>{
    const f=reader(),command=await f.reader.load(f.data.command.payload.operationId);expect(command).toEqual(f.data.command);expect(Object.isFrozen(command)).toBe(true);
    expect(f.authority.current).toHaveBeenCalledTimes(2);
    expect(f.db.outboxEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({aggregateId:f.data.command.payload.operationId,AND:[{payload:{path:['payload','companyId'],equals:f.r.issuerId}},{payload:{path:['payload','issuerRuc'],equals:f.r.issuerRuc}}]})}));
  });
  it('does not read any operation before a denied principal is rejected',async()=>{
    const f=reader();f.authority.current.mockRejectedValueOnce(new Error('REVOKED'));
    await expect(f.reader.load(f.data.command.payload.operationId)).rejects.toThrow('REVOKED');expect(f.db.outboxEvent.findMany).not.toHaveBeenCalled();
  });
  it.each(['not-uuid','../outside','ABCDEFAB-0000-4000-8000-000000000003'])('rejects noncanonical operation ID %s before authentication',async id=>{
    const f=reader();await expect(f.reader.load(id)).rejects.toMatchObject({status:400});expect(f.authority.current).not.toHaveBeenCalled();
  });
  it.each(['missing','duplicate','wrong-event','wrong-operation'] as const)('does not infer a command from incomplete own persistence %s',async mode=>{
    const f=reader(),row={id:f.data.command.eventId,payload:structuredClone(f.data.command)};
    if(mode==='wrong-event')row.id=id(901);
    f.db.outboxEvent.findMany.mockResolvedValue(mode==='missing'?[]:mode==='duplicate'?[row,row]:[row]);
    await expect(f.reader.load(mode==='wrong-operation'?id(902):f.data.command.payload.operationId)).rejects.toThrow();
  });
  it('rejects a grant revision changed before returning the own command',async()=>{
    const f=reader(),first=await f.authority.current();f.authority.current.mockClear();
    f.authority.current.mockResolvedValueOnce(first).mockResolvedValue({...first,grantRevision:2});
    await expect(f.reader.load(f.data.command.payload.operationId)).rejects.toMatchObject({code:'CORRECTION_AUTHORITY_CHANGED'});
  });
  it('assembles only Billing-owned authority/reader and the private transport, without querying on construction',async()=>{
    const f=fixture('PREREQUISITES'),http={post:vi.fn()},token=async()=> 'synthetic-token';
    const ports=createBillingCorrectionEvidencePorts(f.db as never,f.authority,http,token,'SERVICE',f.binding,()=>NOW);
    expect(f.db.document.findFirst).not.toHaveBeenCalled();expect(http.post).not.toHaveBeenCalled();
    expect(await ports.commandAuthority.current(f.data.command)).toEqual(f.actor);expect(await ports.financialAuthority.current()).toEqual(f.actor);
    expect(ports.reservationEvidence.owns({})).toBe(false);expect(ports.financialEvidence.ownsOriginal({})).toBe(false);
    expect(ports).toMatchObject({candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false});expect(http.post).not.toHaveBeenCalled();
  });
});
