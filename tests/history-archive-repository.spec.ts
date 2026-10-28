import {describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {prepareHistoricalImport,historicalSha256} from '../packages/history-core/src';
import {HistoryArchiveRepository} from '../services/history-service/src/repository';
const f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
const databaseName='factuez_history_qa_aabbccddee',markerId=f.uuid(10);
function setup(){
  const input=f.exported(),plan=prepareHistoricalImport(input),snapshot=plan.records[0].snapshot,m=snapshot.ownership;
  const row:any={...m,recordId:plan.records[0].recordId,snapshotSha256:plan.records[0].snapshotSha256,snapshot,
    artifactKeys:[],number:1n,originSystem:'RESTOAPP',originId:snapshot.originId,issueDate:new Date(snapshot.issueDate),
    currencyCode:snapshot.currencyCode,taxableAmount:{toFixed:()=>snapshot.amounts.taxableAmount},
    igvAmount:{toFixed:()=>snapshot.amounts.igvAmount},payableAmount:{toFixed:()=>snapshot.amounts.payableAmount},candidateOnly:true,disposition:'QUARANTINED'};
  const job={jobId:plan.jobId,inputSha256:plan.inputSha256,planSha256:plan.planSha256,mappingSha256:plan.mappingSha256,expectedRows:1,batchSize:50,completedBatches:1};
  const receipt={batchIndex:0,recordsSha256:plan.batches[0].recordsSha256,rowCount:1,insertedCount:1,
    links:[{rowOrdinal:0,recordId:row.recordId,snapshotSha256:row.snapshotSha256,record:row}]};
  const tx:any={$queryRaw:vi.fn(async()=>[{database:databaseName,role:'history_import_qa'}]),
    historySandbox:{findUnique:vi.fn(async()=>({markerId,schemaVersion:'factuez.history-storage.v1',environment:'BETA',datasetClass:'SYNTHETIC'}))},
    historyOwnerMapping:{findUnique:vi.fn(async()=>({...m,mappingSha256:historicalSha256(m)}))},
    historyImportJob:{findUnique:vi.fn(async()=>job)},historyBatchReceipt:{findMany:vi.fn(async()=>[receipt])},
    historyRecord:{findFirst:vi.fn(async()=>row),findMany:vi.fn(async()=>[row])}};
  const prisma={$transaction:vi.fn(async action=>action(tx))};
  return {input,plan,row,job,receipt,tx,prisma,repo:new HistoryArchiveRepository(prisma as any,{databaseName,markerId})};
}
describe('historial: prefijo persistido y conexión atestada',()=>{
  it('comprueba snapshot entero, vínculos y recibos antes de aceptar checkpoint',async()=>{
    const s=setup();expect(await s.repo.checkpoint(s.input,f.actor())).toMatchObject({completedBatches:1,complete:true,fiscalAuthority:false});
    expect(s.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'Serializable',maxWait:2000,timeout:20000});
  });
  it.each(['database','role'])('conexión %s incorrecta no accede a tablas',async field=>{
    const s=setup();s.tx.$queryRaw.mockResolvedValue([{database:databaseName,role:'history_import_qa',[field]:'outside'}]);
    await expect(s.repo.checkpoint(s.input,f.actor())).rejects.toThrow(/SANDBOX_CONNECTION_MISMATCH/);
    expect(s.tx.historySandbox.findUnique).not.toHaveBeenCalled();
  });
  it('lector no alcanza siquiera el mapa al intentar importar',async()=>{
    const s=setup();s.tx.$queryRaw.mockResolvedValue([{database:databaseName,role:'history_reader_qa'}]);
    await expect(s.repo.preflight(s.input,f.actor())).rejects.toThrow(/SANDBOX_ROLE_READONLY/);
    expect(s.tx.historyOwnerMapping.findUnique).not.toHaveBeenCalled();
  });
  it('marcador incorrecto corta acceso antes del mapa',async()=>{
    const s=setup();s.tx.historySandbox.findUnique.mockResolvedValue({markerId:f.uuid(11)});
    await expect(s.repo.checkpoint(s.input,f.actor())).rejects.toThrow(/SANDBOX_MARKER_MISMATCH/);
    expect(s.tx.historyOwnerMapping.findUnique).not.toHaveBeenCalled();
  });
  it.each(['inputSha256','planSha256','mappingSha256','expectedRows','batchSize','completedBatches'])('vinculación %s inválida',async key=>{
    const s=setup();(s.job as any)[key]=typeof(s.job as any)[key]==='number'?-1:'f'.repeat(64);
    await expect(s.repo.checkpoint(s.input,f.actor())).rejects.toThrow(/JOB_BINDING_MISMATCH/);
  });
  it.each(['receiptMissing','batchIndex','receiptSha','rowCount','insertedCount','linkMissing','ordinal','linkId','linkSha'])('prefijo alterado: %s',async field=>{
    const s=setup();
    if(field==='receiptMissing')s.tx.historyBatchReceipt.findMany.mockResolvedValue([]);
    if(field==='batchIndex')s.receipt.batchIndex=1;
    if(field==='receiptSha')s.receipt.recordsSha256='f'.repeat(64);
    if(field==='rowCount')s.receipt.rowCount=2;
    if(field==='insertedCount')s.receipt.insertedCount=2;
    if(field==='linkMissing')s.receipt.links=[];
    if(field==='ordinal')s.receipt.links[0].rowOrdinal=1;
    if(field==='linkId')s.receipt.links[0].recordId='f'.repeat(64);
    if(field==='linkSha')s.receipt.links[0].snapshotSha256='f'.repeat(64);
    await expect(s.repo.checkpoint(s.input,f.actor())).rejects.toThrow(/CHECKPOINT_INTEGRITY/);
  });
  it.each(['snapshot','snapshotSha256','recordId','branchId','number','currencyCode','payableAmount','artifactKeys','disposition','candidateOnly'])('registro alterado: %s bloquea lectura y checkpoint',async field=>{
    const s=setup();
    if(field==='snapshot')s.row.snapshot={...s.row.snapshot,customer:{...s.row.snapshot.customer,legalName:'FICTICIO MODIFICADO'}};
    else if(field==='payableAmount')s.row.payableAmount={toFixed:()=> '0.00'};
    else if(field==='number')s.row.number=2n;
    else if(field==='candidateOnly')s.row.candidateOnly=false;
    else if(field==='artifactKeys')s.row.artifactKeys=[{kind:'CDR_XML',key:'inventado'}];
    else s.row[field]=field==='currencyCode'?'USD':'f'.repeat(64);
    await expect(s.repo.checkpoint(s.input,f.actor())).rejects.toThrow(/RECORD_INTEGRITY/);
    await expect(s.repo.detail(s.plan.records[0].recordId,f.actor(false))).rejects.toThrow(/RECORD_INTEGRITY/);
  });
  it('Serialización se reintenta tres veces; sin filtrar detalles del driver',async()=>{
    const s=setup();s.prisma.$transaction.mockRejectedValue({code:'P2034',message:'DO_NOT_EXPOSE'});
    await expect(s.repo.checkpoint(s.input,f.actor())).rejects.toThrow(/^Historial aislado: HISTORY_STORAGE_FAILED$/);
    expect(s.prisma.$transaction).toHaveBeenCalledTimes(3);
  });
  it('errores ordinarios no se reintentan ni exponen URL/filas',async()=>{
    const s=setup();s.prisma.$transaction.mockRejectedValue(new Error('DO_NOT_EXPOSE'));
    await expect(s.repo.checkpoint(s.input,f.actor())).rejects.toThrow(/^Historial aislado: HISTORY_STORAGE_FAILED$/);
    expect(s.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('modo READ_ONLY rechaza importar antes de conectar',async()=>{
    const s=setup(),repo=new HistoryArchiveRepository(s.prisma as any,{databaseName,markerId},'READ_ONLY');
    await expect(repo.preflight(s.input,f.actor())).rejects.toThrow(/SANDBOX_ROLE_READONLY/);expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('modo READ_ONLY no acepta credencial de DB importadora para leer',async()=>{
    const s=setup(),repo=new HistoryArchiveRepository(s.prisma as any,{databaseName,markerId},'READ_ONLY');
    await expect(repo.detail(s.row.recordId,f.actor())).rejects.toThrow(/SANDBOX_READER_REQUIRED/);expect(s.tx.historyRecord.findFirst).not.toHaveBeenCalled();
  });
  it('modo de acceso inválido no se normaliza al permisivo',()=>{
    const s=setup();expect(()=>new HistoryArchiveRepository(s.prisma as any,{databaseName,markerId},'invalid' as any)).toThrow(/INVALID_ACCESS_MODE/);
  });
  const query={issuerRuc:null,branchId:null,documentTypeCode:null,series:null,take:1,afterRecordId:null};
  it('reporte aplica el alcance antes de leer y no concilia sólo la primera página',async()=>{
    const s=setup(),r=await s.repo.reconciliation(query,f.actor(false));expect(r.count).toBe(1);
    expect(s.tx.historyRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{branchId:{in:f.actor(false).scope.branchIds},
      emissionPointId:{in:f.actor(false).scope.emissionPointIds},seriesCounterId:{in:f.actor(false).scope.seriesCounterIds}},take:2001}));
  });
  it('reporte rechaza prefijo/cursor en vez de fingir totales completos',async()=>{
    const s=setup();await expect(s.repo.reconciliation({...query,afterRecordId:'a'.repeat(64)},f.actor())).rejects.toThrow(/RECONCILIATION_CURSOR_NOT_ALLOWED/);
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('reporte sobre límite se bloquea, no corta filas silenciosamente',async()=>{
    const s=setup();s.tx.historyRecord.findMany.mockResolvedValue(Array(2001).fill(s.row));
    await expect(s.repo.reconciliation(query,f.actor())).rejects.toThrow(/RECONCILIATION_LIMIT/);
  });
  it('reporte detecta snapshot corrupto antes de sumar',async()=>{
    const s=setup();s.row.snapshotSha256='f'.repeat(64);await expect(s.repo.reconciliation(query,f.actor())).rejects.toThrow(/RECORD_INTEGRITY/);
  });
});
