import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe,it,expect,vi } from 'vitest';
import { B2bReports,createReportsRenderers } from '../services/billing-service/src/b2b/phase8-reports';
import { reportsFixture,createInput,filters,binding } from './b2b-phase8-reports.fixture';
const code=(c:string)=>expect.objectContaining({code:c});
describe('B2B08 reports candidate',()=>{
  it('disabled by default before any access',async()=>{
    const f=reportsFixture(),core=new B2bReports(f.store,f.identity,f.port);
    await expect(core.execute(f.auth,'DASHBOARD',{filters})).rejects.toEqual(code('REPORTS_DISABLED'));expect(f.identity.authenticate).not.toHaveBeenCalled();
  });
  it('real billing capture produces exact scoped summary without rows',async()=>{
    const f=reportsFixture(),r=await f.reports.execute(f.auth,'DASHBOARD',{filters});
    expect(r.data.groups[0]).toMatchObject({currency:'PEN',type:'01',local:'ISSUED',payableAmount:'118.00',taxableAmount:'100.00',igvAmount:'18.00'});
    expect(r.data.count).toBe(1);expect(r.data.rows).toBeUndefined();expect(f.port.execute).toHaveBeenCalledWith(f.auth.token,'SERVICE','capture',filters);
  });
  it('keeps values beyond safe integer and twelve decimals',async()=>{
    const f=reportsFixture(),row=f.rows[0];row.payableAmount='9007199254740993.000000000001';row.immutableSnapshot.totals.payableAmount=row.payableAmount;
    expect((await f.reports.execute(f.auth,'DASHBOARD',{filters})).data.groups[0].payableAmount).toBe(row.payableAmount);
  });
  it('preserves unknown tax totals',async()=>{
    const f=reportsFixture();delete f.rows[0].immutableSnapshot.totals.taxableAmount;
    expect((await f.reports.execute(f.auth,'DASHBOARD',{filters})).data.groups[0]).toMatchObject({taxableAmount:null,missingTaxableCount:1});
  });
  it('separates currencies and cancelled amounts',async()=>{
    const f=reportsFixture();for(const [i,currency,status]of [[2,'USD','ISSUED'],[3,'PEN','CANCELLED']]as const){const row=structuredClone(f.rows[0]);row.id=`40000000-0000-4000-8000-00000000000${i}`;row.immutableSnapshot.documentId=row.id;row.immutableSnapshot.currencyCode=currency;row.status=status;f.rows.push(row);}
    const r=await f.reports.execute(f.auth,'DASHBOARD',{filters});expect(r.data.groups).toHaveLength(3);expect(r.data.groups.every((g:any)=>g.payableAmount==='118.00')).toBe(true);
  });
  it.each(['b2b:reports:read','b2b:documents:read','b2b:reports:export']as const)('requires %s',async scope=>{
    const f=reportsFixture();f.p.scopes=f.p.scopes.filter(s=>s!==scope);await expect(f.reports.execute(f.auth,'CREATE',createInput)).rejects.toEqual(code('SCOPE_REQUIRED'));expect(f.port.execute).not.toHaveBeenCalled();
  });
  it('rejects a foreign full binding',async()=>{
    const f=reportsFixture();f.rows[0].seriesCounter.id='30000000-0000-4000-8000-000000000099';
    await expect(f.reports.execute(f.auth,'DASHBOARD',{filters})).rejects.toEqual(code('RESOURCE_NOT_FOUND'));
  });
  it('detects binding/revision changes after capture with rollback',async()=>{
    const f=reportsFixture();f.repository.capture.mockImplementationOnce(async()=>{f.p.revision++;return structuredClone(f.rows);});
    await expect(f.reports.execute(f.auth,'CREATE',createInput)).rejects.toEqual(code('ACCESS_CHANGED'));expect(f.store.jobs.size).toBe(0);
  });
  it('rejects unsupported source, broad range, unknown fields',async()=>{
    const f=reportsFixture();await expect(f.reports.execute(f.auth,'DASHBOARD',{filters:{...filters,types:'07'}})).rejects.toEqual(code('SOURCE_NOT_SUPPORTED'));
    await expect(f.reports.execute(f.auth,'DASHBOARD',{filters:{...filters,from:'2024-01-01'}})).rejects.toEqual(code('INVALID_DATE_RANGE'));
    await expect(f.reports.execute(f.auth,'CREATE',{...createInput,ownerKey:'injected'})).rejects.toEqual(code('INVALID_REQUEST'));
  });
  it('rejects duplicates, dates outside filters and captures over limit',async()=>{
    const f=reportsFixture();f.rows.push(structuredClone(f.rows[0]));await expect(f.reports.execute(f.auth,'DASHBOARD',{filters})).rejects.toEqual(code('REPORT_CAPTURE_INVALID'));
    f.rows.pop();await expect(f.reports.execute(f.auth,'DASHBOARD',{filters:{...filters,from:'2026-01-02'}})).rejects.toEqual(code('REPORT_CAPTURE_INVALID'));
    f.repository.capture.mockResolvedValueOnce(Array(10001).fill(f.rows[0]));await expect(f.reports.execute(f.auth,'DASHBOARD',{filters})).rejects.toEqual(code('NARROW_QUERY'));
  });
  it('creates durable job, private metadata and content SHA',async()=>{
    const f=reportsFixture(),made=await f.reports.execute(f.auth,'CREATE',createInput);expect(made.data).toMatchObject({state:'READY',revision:2,count:1});
    const read=await f.reports.execute(f.auth,'READ',{id:made.data.id});expect(JSON.stringify(read)).not.toContain(f.auth.token);expect(read.data.capture).toBeUndefined();
    const file=await f.reports.execute(f.auth,'CONTENT',{id:made.data.id});expect(file.sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'));
    expect(file.bytes.toString()).toContain('118.00');expect(file.mediaType).toBe('text/csv; charset=utf-8');
  });
  it('replay preserves original capture and conflicts on changed request',async()=>{
    const f=reportsFixture(),first=await f.reports.execute(f.auth,'CREATE',createInput);f.rows.length=0;
    const second=await f.reports.execute(f.auth,'CREATE',createInput);expect(second.data).toEqual(first.data);expect(second.replayed).toBe(true);expect(f.port.execute).toHaveBeenCalledTimes(1);
    await expect(f.reports.execute(f.auth,'CREATE',{...createInput,filters:{...filters,to:'2026-01-03'}})).rejects.toEqual(code('IDEMPOTENCY_CONFLICT'));
  });
  it('resumes QUEUED job after render failure without recapture',async()=>{
    let first=true;const renderer=vi.fn(async()=>{if(first){first=false;throw new Error('private details');}return {bytes:Buffer.from('resumed'),mediaType:'text/csv; charset=utf-8'};});
    const f=reportsFixture({renderers:{CSV:renderer}});await expect(f.reports.execute(f.auth,'CREATE',createInput)).rejects.toEqual(code('REPORT_RENDER_FAILED'));
    expect([...f.store.jobs.values()][0].state).toBe('QUEUED');f.rows.length=0;expect((await f.reports.execute(f.auth,'CREATE',createInput)).data.count).toBe(1);expect(f.port.execute).toHaveBeenCalledTimes(1);
  });
  it('concurrent same-key requests persist exactly once',async()=>{
    const f=reportsFixture();const [a,b]=await Promise.all([f.reports.execute(f.auth,'CREATE',createInput),f.reports.execute(f.auth,'CREATE',createInput)]);
    expect(a.data).toEqual(b.data);expect(f.store.jobs.size).toBe(1);expect(f.port.execute).toHaveBeenCalledTimes(1);
  });
  it('isolates client, actor kind, human subject and revisions',async()=>{
    const f=reportsFixture(),made=await f.reports.execute(f.auth,'CREATE',createInput);f.p.revision++;
    await expect(f.reports.execute(f.auth,'READ',{id:made.data.id})).rejects.toEqual(code('RESOURCE_NOT_FOUND'));f.p.revision--;
    f.p.clientId='80000000-0000-4000-8000-000000000002';await expect(f.reports.execute(f.auth,'CONTENT',{id:made.data.id})).rejects.toEqual(code('RESOURCE_NOT_FOUND'));
    f.p.kind='USER';f.p.subjectId='80000000-0000-4000-8000-000000000003';f.p.userAuthRevision=0;const auth={...f.auth,kind:'USER' as const};
    const userJob=await f.reports.execute(auth,'CREATE',createInput);f.p.subjectId='80000000-0000-4000-8000-000000000004';
    await expect(f.reports.execute(auth,'READ',{id:userJob.data.id})).rejects.toEqual(code('RESOURCE_NOT_FOUND'));
  });
  it('rechecks all saved bindings when grants shrink',async()=>{
    const f=reportsFixture(),made=await f.reports.execute(f.auth,'CREATE',createInput);f.p.bindings=[{...binding,pointId:'20000000-0000-4000-8000-000000000099'}];
    await expect(f.reports.execute(f.auth,'CONTENT',{id:made.data.id})).rejects.toEqual(code('RESOURCE_NOT_FOUND'));
  });
  it('export permission gates bytes but not metadata',async()=>{
    const f=reportsFixture(),made=await f.reports.execute(f.auth,'CREATE',createInput);f.p.scopes=f.p.scopes.filter(s=>s!=='b2b:reports:export');
    expect((await f.reports.execute(f.auth,'READ',{id:made.data.id})).data.state).toBe('READY');await expect(f.reports.execute(f.auth,'CONTENT',{id:made.data.id})).rejects.toEqual(code('SCOPE_REQUIRED'));
  });
  it('detects capture and content tampering',async()=>{
    const f=reportsFixture(),made=await f.reports.execute(f.auth,'CREATE',createInput);f.store.files.get(made.data.id)!.bytes=Buffer.from('changed');
    await expect(f.reports.execute(f.auth,'CONTENT',{id:made.data.id})).rejects.toEqual(code('REPORT_CONTENT_INTEGRITY'));
    f.store.jobs.get(made.data.id)!.capture.rows[0].payableAmount='0.00';await expect(f.reports.execute(f.auth,'READ',{id:made.data.id})).rejects.toEqual(code('REPORT_CAPTURE_INTEGRITY'));
  });
  it('blocks bytes when identity changes during content I/O',async()=>{
    const f=reportsFixture(),made=await f.reports.execute(f.auth,'CREATE',createInput),original=f.store.transaction.bind(f.store);
    f.store.transaction=(key,work)=>original(key,tx=>work({...tx,content:async(owner,id)=>{const file=await tx.content(owner,id);f.p.revision++;return file;}}));
    await expect(f.reports.execute(f.auth,'CONTENT',{id:made.data.id})).rejects.toEqual(code('ACCESS_CHANGED'));
  });
  it('unconfigured XLSX fails before capture',async()=>{
    const f=reportsFixture();await expect(f.reports.execute(f.auth,'CREATE',{...createInput,format:'XLSX'})).rejects.toEqual(code('FORMAT_NOT_AVAILABLE'));expect(f.port.execute).not.toHaveBeenCalled();
  });
  it('generates XLSX/PDF using already installed injected dependencies',async()=>{
    const req=createRequire(new URL('../services/received-documents-service/package.json',import.meta.url));
    const {Workbook}=req('exceljs'),PdfDocument=req('pdfkit'),f=reportsFixture({renderers:createReportsRenderers({Workbook,PdfDocument})});
    for(const format of ['XLSX','PDF']){const made=await f.reports.execute(f.auth,'CREATE',{...createInput,format,idempotencyKey:'synthetic_format_'+format});
      const file=await f.reports.execute(f.auth,'CONTENT',{id:made.data.id});expect(file.bytes.subarray(0,format==='PDF'?4:2).toString()).toBe(format==='PDF'?'%PDF':'PK');
      if(format==='XLSX'){const w=new Workbook();await w.xlsx.load(file.bytes);expect(w.getWorksheet('Documents').getRow(2).getCell(11).value).toBe('118.00');}}
  });
});