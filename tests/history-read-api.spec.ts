import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHistoryReadApp} from '../services/history-service/src/read-api';
import {HistoryReadAccessError} from '../services/history-service/src/read-identity';
import {createRequire} from 'node:module';
const f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
const policy={fiscalAuthority:false,cdrAuthenticityVerified:false,countersChanged:false,transmission:false};
describe('historial: API Nest de sólo lectura, composición simulada',()=>{
  let app:Awaited<ReturnType<typeof createHistoryReadApp>>,disabled:typeof app,url:string,disabledUrl:string;
  const service={list:vi.fn(async()=>[{recordId:'a'.repeat(64)}]),detail:vi.fn(async()=>({recordId:'a'.repeat(64),snapshot:f.document(),artifactKeys:[{key:'PRIVATE_STORAGE_KEY'}],...policy})),
    artifact:vi.fn(async()=>({bytes:Buffer.from('FICTICIO NO OFICIAL'),originalName:'prueba-local.xml',...policy})),reconciliation:vi.fn(async()=>({count:1,...policy}))};
  beforeAll(async()=>{
    app=await createHistoryReadApp({enabled:true,environment:'BETA',datasetClass:'SYNTHETIC',service:service as any});
    disabled=await createHistoryReadApp({service:service as any});
    await app.listen(0,'127.0.0.1');await disabled.listen(0,'127.0.0.1');url=await app.getUrl();disabledUrl=await disabled.getUrl();
  });
  afterAll(async()=>{await app?.close();await disabled?.close();});
  const headers={Authorization:'Bearer qa-token'};
  it('perfil queda deshabilitado por defecto incluso si le dan el port',async()=>{
    const r=await fetch(disabledUrl+'/api/v1/history/documents',{headers});expect(r.status).toBe(503);
    expect((await fetch(disabledUrl+'/health').then(r=>r.json())).status).toBe('disabled');
  });
  it.each(['environment','datasetClass'])('no habilita perfil inválido %s',async field=>{
    await expect(createHistoryReadApp({enabled:true,environment:'BETA',datasetClass:'SYNTHETIC',service:service as any,[field]:'PRODUCTION'} as any)).rejects.toThrow(/SYNTHETIC_PROFILE_REQUIRED/);
  });
  it('sin Bearer no llama al port ni consulta la BD',async()=>{
    const before=service.list.mock.calls.length,r=await fetch(url+'/api/v1/history/documents',{headers:{'x-user-id':'inventado'}});
    expect(r.status).toBe(401);expect(service.list.mock.calls.length).toBe(before);
  });
  it('filtros, esquema y cursor se traducen sin scopes del navegador',async()=>{
    const r=await fetch(url+'/api/v1/history/documents?take=1&issuerRuc=00000000001',{headers});expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({schemaVersion:'factuez.history-read.v1',environment:'BETA',datasetClass:'SYNTHETIC',readOnly:true,nextCursor:'a'.repeat(64),...policy});
    expect(service.list).toHaveBeenLastCalledWith(expect.objectContaining({take:1,issuerRuc:'00000000001',branchId:null}),'qa-token');
    expect(r.headers.get('cache-control')).toBe('private, no-store');expect(r.headers.get('x-powered-by')).toBeNull();
  });
  it.each(['scope=GLOBAL','take=0','take=101','take=1&take=2','take=1e2','unknown=true','__proto__=x'])('query %s bloqueado',async q=>{
    const before=service.list.mock.calls.length,r=await fetch(url+`/api/v1/history/documents?${q}`,{headers});expect(r.status).toBe(400);expect(service.list.mock.calls.length).toBe(before);
  });
  it('detalle no revela las claves de almacenamiento',async()=>{
    const r=await fetch(url+'/api/v1/history/documents/'+'a'.repeat(64),{headers});expect(r.status).toBe(200);
    const data=await r.json();expect(data.snapshot.items).toHaveLength(1);expect(data).not.toHaveProperty('artifactKeys');expect(JSON.stringify(data)).not.toContain('PRIVATE_STORAGE_KEY');
  });
  it('artefactos se descargan como adjunto, no se ejecutan en el origen',async()=>{
    const r=await fetch(url+'/api/v1/history/documents/'+'a'.repeat(64)+'/artifacts/CDR_XML',{headers});expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');expect(r.headers.get('content-disposition')).toContain('attachment;');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(await r.text()).toBe('FICTICIO NO OFICIAL');
  });
  it('nombre internacional y apóstrofe no rompen el header de descarga',async()=>{
    service.artifact.mockResolvedValueOnce({bytes:Buffer.from('FICTICIO'),originalName:"recibo José's.xml",...policy});
    const r=await fetch(url+'/api/v1/history/documents/'+'a'.repeat(64)+'/artifacts/CDR_XML',{headers});
    expect(r.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''recibo%20Jos%C3%A9%27s.xml");
  });
  it('reporte es consulta independiente de página',async()=>{
    expect((await fetch(url+'/api/v1/history/reconciliation',{headers})).status).toBe(200);
    expect((await fetch(url+'/api/v1/history/reconciliation?take=1',{headers})).status).toBe(400);
    expect((await fetch(url+'/api/v1/history/reconciliation?afterRecordId='+'a'.repeat(64),{headers})).status).toBe(400);
  });
  it.each(['POST','PATCH','PUT','DELETE'])('método %s no tiene ruta de importación/emisión/corte',async method=>{
    const r=await fetch(url+'/api/v1/history/documents',{method,headers});expect(r.status).toBe(404);
  });
  it('errores internos nunca exponen stack, SQL, token o URL',async()=>{
    service.list.mockRejectedValueOnce(new Error('SECRET_DATABASE_URL'));
    const r=await fetch(url+'/api/v1/history/documents',{headers});expect(r.status).toBe(503);
    expect(await r.json()).toEqual({statusCode:503,code:'HISTORY_UNAVAILABLE'});
  });
  it('denegación del Identity port mantiene 403',async()=>{
    service.list.mockRejectedValueOnce(new HistoryReadAccessError(403,'HISTORY_PERMISSION_DENIED'));
    expect((await fetch(url+'/api/v1/history/documents',{headers})).status).toBe(403);
  });
});
