import {describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {historyActor,historyListQuery,historyScopeWhere} from '../services/history-service/src/access';
import {HistoricalArchiveService,denyHistoricalCutover} from '../services/history-service/src/service';
import {HistoryArchiveRepository} from '../services/history-service/src/repository';
const f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
describe('historial: autorización y composición sin emisión',()=>{
  it('GLOBAL exige ADMIN y permiso, no basta rol genérico',()=>{
    expect(historyActor(f.actor(),'history.import').scope.kind).toBe('GLOBAL');
    const a=f.actor();a.roles=['CASHIER'];expect(()=>historyActor(a,'history.view')).toThrow(/GLOBAL_SCOPE_DENIED/);
    a.roles=['ADMIN'];a.permissions=[];expect(()=>historyActor(a,'history.import')).toThrow(/PERMISSION_DENIED/);
  });
  it('importación asignada se deniega aun con el permiso',()=>{
    const a=f.actor(false);a.permissions.push('history.import');expect(()=>historyActor(a,'history.import')).toThrow(/IMPORT_SCOPE_DENIED/);
  });
  it('alcance combina sede, punto y UUID de serie, no etiqueta F001',()=>{
    const actor=historyActor(f.actor(false),'history.view'),where=historyScopeWhere(actor);
    expect(where).toEqual({branchId:{in:[f.mapping().branchId]},emissionPointId:{in:[f.mapping().emissionPointId]},seriesCounterId:{in:[f.mapping().seriesCounterId]}});
    const bad=f.actor(false);bad.scope.seriesCounterIds=['BQ01'];expect(()=>historyActor(bad,'history.view')).toThrow();
  });
  it.each(['userId','scope','permissions'])('accessor actor %s bloqueado sin ejecutar',key=>{
    const a=f.actor(),get=vi.fn();Object.defineProperty(a,key,{enumerable:true,get});expect(()=>historyActor(a,'history.view')).toThrow();expect(get).not.toHaveBeenCalled();
  });
  it.each([0,101,1.5,'10'])('paginación %s fuera del contrato',take=>{
    expect(()=>historyListQuery({issuerRuc:null,branchId:null,documentTypeCode:null,series:null,take,afterRecordId:null})).toThrow();
  });
  it('guard de nombre bloquea construir adaptador hacia Billing',()=>{
    expect(()=>new HistoryArchiveRepository({$transaction:vi.fn()} as any,{databaseName:'factuez_billing_qa',markerId:f.uuid(10)})).toThrow(/SANDBOX_NAME_REQUIRED/);
  });
  it('permiso denegado no lee DB ni disco',async()=>{
    const repository={list:vi.fn(),preflight:vi.fn()},artifacts={stageBatch:vi.fn()},identity={authorize:vi.fn(async()=>({...f.actor(),permissions:[]}))};
    const service=new HistoricalArchiveService(identity,repository as any,artifacts as any);
    await expect(service.importNext(f.exported(),'qa-token')).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(service.list({},'qa-token')).rejects.toThrow(/PERMISSION_DENIED/);
    expect(repository.list).not.toHaveBeenCalled();expect(repository.preflight).not.toHaveBeenCalled();expect(artifacts.stageBatch).not.toHaveBeenCalled();
  });
  it('revocación tras staging no confirma lote',async()=>{
    const identity={authorize:vi.fn().mockResolvedValueOnce(f.actor()).mockRejectedValueOnce(new Error('revoked'))};
    const repository={preflight:vi.fn(async()=>({plan:{normalized:f.exported()}})),checkpoint:vi.fn(async()=>({complete:false,completedBatches:0})),commitBatch:vi.fn()};
    const artifacts={stageBatch:vi.fn(async()=>[])};
    await expect(new HistoricalArchiveService(identity,repository as any,artifacts as any).importNext(f.exported(),'qa-token')).rejects.toThrow('revoked');
    expect(repository.commitBatch).not.toHaveBeenCalled();expect(identity.authorize).toHaveBeenCalledTimes(2);
  });
  it('estado completo no crea archivos ni confirma otra vez',async()=>{
    const repository={preflight:vi.fn(async()=>({plan:{normalized:f.exported()}})),checkpoint:vi.fn(async()=>({complete:true,completedBatches:1}))},artifacts={stageBatch:vi.fn()};
    const result=await new HistoricalArchiveService({authorize:async()=>f.actor()},repository as any,artifacts as any).importNext(f.exported(),'qa-token');
    expect(result).toMatchObject({deduplicated:true,insertedCount:0});expect(artifacts.stageBatch).not.toHaveBeenCalled();
  });
  it('no expone cambio de propietario/correlativo',()=>{expect(()=>denyHistoricalCutover({nextNumber:999})).toThrow(/HISTORY_REAL_COPY_AND_CUTOVER_DISABLED/);});
});
