import { createRequire } from 'node:module';
import { describe,it,expect,vi } from 'vitest';
import { B2bReports,createReportsRenderers,PostgresBillingReportSources,reportsFilters } from '../services/billing-service/src/b2b/phase8-reports';
import { decimalText,sealCapture,summary } from '../services/billing-service/src/b2b/phase8-reports/validation';
import { reportsSourcesFixture,reportsGuideSourcesFixture as withGuide,sourceId } from './b2b-phase8-reports-sources.fixture';
const code=(code:string)=>expect.objectContaining({code});
const req=createRequire(new URL('../services/received-documents-service/package.json',import.meta.url));
const {Workbook}=req('exceljs'),PdfDocument=req('pdfkit');
describe('B2B08 verified owner source coverage',()=>{
  it('keeps the shared default and enables extended filters only by explicit composition',()=>{
    expect(()=>reportsFilters({issuerId:'1',environment:'BETA',from:'2026-01-01',to:'2026-01-02',types:'07'})).toThrow('SOURCE_NOT_SUPPORTED');
    expect(reportsFilters({issuerId:'1',environment:'BETA',from:'2026-01-01',to:'2026-01-02',types:'NV,07'},true).types).toEqual(['07','NV']);
    for(const types of ['07,07','07,','99'])expect(()=>reportsFilters({issuerId:'1',environment:'BETA',from:'2026-01-01',to:'2026-01-02',types},true)).toThrow('INVALID_DOCUMENT_TYPES');
  });
  it('aggregates credit negatively, debit positively, and commercial notes separately from net sales',async()=>{
    const f=reportsSourcesFixture(),r=await f.core().execute(f.auth,'DASHBOARD',{filters:f.filters('01,07,08,NV')});
    expect(r).toMatchObject({source:'BILLING_OWNER_SOURCES',fiscalAuthority:false,candidateOnly:true});
    expect(r.data.count).toBe(4);expect(r.data.groups.find((g:any)=>g.type==='07')).toMatchObject({payableAmount:'-118.00',taxableAmount:'-100.00',igvAmount:'-18.00'});
    expect(r.data.groups.find((g:any)=>g.type==='08').payableAmount).toBe('118.00');
    expect(r.data.netSales).toEqual([{currency:'PEN',payableAmount:'118.00'}]);expect(r.data.transfers).toEqual([]);
    expect(r.data.coverage.every((x:any)=>x.fiscalAcceptance==='NOT_ASSERTED')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('DO_NOT_EXPOSE');
  });
  it('formats negative subunits and exact large credit values without floating point',async()=>{
    expect(decimalText(-1n)).toBe('-0.000000000001');
    const f=reportsSourcesFixture(),d=f.records[0].value.document;
    d.payableAmount='9007199254740993.000000000001';d.immutableSnapshot.totals.payableAmount=d.payableAmount;
    const r=await f.core().execute(f.auth,'DASHBOARD',{filters:f.filters('07')});
    expect(r.data.groups[0].payableAmount).toBe('-9007199254740993.000000000001');
  });
  it('keeps currencies separate and excludes cancelled adjustments from net sales',async()=>{
    const f=reportsSourcesFixture();f.records[0].value.document.status='CANCELLED';
    const debit=f.records[1].value;debit.document.immutableSnapshot.currencyCode='USD';debit.original.immutableSnapshot.currencyCode='USD';
    const r=await f.core().execute(f.auth,'DASHBOARD',{filters:f.filters('07,08')});
    expect(r.data.netSales).toEqual([{currency:'USD',payableAmount:'118.00'}]);
    expect(r.data.groups.find((g:any)=>g.type==='07').local).toBe('CANCELLED');
  });
  it('filters by the actual note series rather than its reference invoice series',async()=>{
    const f=reportsSourcesFixture();
    const r=await f.core().execute(f.auth,'DASHBOARD',{filters:{...f.filters('07'),seriesId:f.pairs[0].noteSeriesId}});
    expect(r.data.count).toBe(1);expect(f.sourceStore.capture.mock.calls[0][2]).toHaveLength(1);
  });
  it.each(['issuerRuc','branchId','pointId','environment'])('rejects a foreign %s filter before reading owner tables',async field=>{
    const f=reportsSourcesFixture(),filters={...f.filters('07'),[field]:field==='issuerRuc'?'20444444444':field==='environment'?'PRODUCTION':sourceId(99)};
    await expect(f.core().execute(f.auth,'DASHBOARD',{filters})).rejects.toMatchObject({code:expect.any(String)});
    expect(f.sourceStore.capture).not.toHaveBeenCalled();
  });
  it.each(['b2b:corrections:read','b2b:sales-notes:read'] as const)('requires the source read scope %s before reading source tables',async scope=>{
    const f=reportsSourcesFixture();f.p.scopes=f.p.scopes.filter(s=>s!==scope);
    await expect(f.core().execute(f.auth,'DASHBOARD',{filters:f.filters()})).rejects.toEqual(code('SCOPE_REQUIRED'));
    expect(f.sourceStore.capture).not.toHaveBeenCalled();
  });
  it('requires a READ paired correction proof and never infers it from a write proof',async()=>{
    const f=reportsSourcesFixture();f.correctionAuthority.current.mockImplementationOnce(async()=>({action:'WRITE'} as any));
    await expect(f.core().execute(f.auth,'CREATE',f.input('07'))).rejects.toEqual(code('INVALID_REPORT_SOURCE_AUTHORIZATION'));
    expect(f.sourceStore.capture).not.toHaveBeenCalled();
  });
  it('rechecks paired grant revisions even for an empty persisted capture',async()=>{
    const f=reportsSourcesFixture();f.records.length=0;const core=f.core(),made=await core.execute(f.auth,'CREATE',f.input('07'));
    expect(made.data.count).toBe(0);f.control.grantRevision++;
    await expect(core.execute(f.auth,'CONTENT',{id:made.data.id})).rejects.toEqual(code('ACCESS_CHANGED'));
    await expect(core.execute(f.auth,'READ',{id:made.data.id})).rejects.toEqual(code('ACCESS_CHANGED'));
  });
  it('rejects an unrelated original, inconsistent totals, a duplicate snapshot and an out-of-range date',async()=>{
    for(const mutate of [
      (f:any)=>{f.records[0].value.document.immutableSnapshot.reference.documentId=sourceId(98);},
      (f:any)=>{f.records[0].value.document.payableAmount='1.00';},
      (f:any)=>{f.records.push(structuredClone(f.records[0]));},
      (f:any)=>{f.records[0].value.document.immutableSnapshot.environment='PRODUCTION';},
      (f:any)=>{f.records[0].value.document.issueDate='2026-02-01T12:00:00.000Z';f.records[0].value.document.immutableSnapshot.issueDate='2026-02-01T12:00:00.000Z';},
    ]){
      const f=reportsSourcesFixture();mutate(f);
      await expect(f.core().execute(f.auth,'CREATE',f.input('07'))).rejects.toMatchObject({code:expect.any(String)});
      expect(f.store.jobs.size).toBe(0);
    }
  });
  it('persists the latest document snapshot once and preserves it on replay after a correction changes',async()=>{
    const f=reportsSourcesFixture(),core=f.core(),made=await core.execute(f.auth,'CREATE',f.input('07'));
    const d=f.records[0].value.document;d.payableAmount='59.00';d.immutableSnapshot.totals.payableAmount='59.00';
    const replay=await core.execute(f.auth,'CREATE',f.input('07'));expect(replay.data).toEqual(made.data);expect(replay.replayed).toBe(true);
    const fresh=await core.execute(f.auth,'CREATE',{...f.input('07'),idempotencyKey:'synthetic_latest_snapshot_002'});
    const first=f.store.jobs.get(made.data.id)!,next=f.store.jobs.get(fresh.data.id)!;
    expect(first.capture.rows[0].payableAmount).toBe('118.00');expect(next.capture.rows[0].payableAmount).toBe('59.00');
    expect(first.capture.rows[0].snapshotSha256).not.toBe(next.capture.rows[0].snapshotSha256);
    expect(f.sourceStore.capture).toHaveBeenCalledTimes(2);
  });
  it('rejects incomplete or tampered sales notes and never treats conversion as another fiscal sale',async()=>{
    const f=reportsSourcesFixture();f.nv.state='CONVERTED';f.nv.convertedDocumentId=sourceId(70) as any;
    const r=await f.core().execute(f.auth,'DASHBOARD',{filters:f.filters('NV')});expect(r.data.netSales).toEqual([]);expect(r.data.count).toBe(1);
    f.nv.completedSha256='0'.repeat(64);
    await expect(f.core().execute(f.auth,'CREATE',f.input('NV'))).rejects.toEqual(code('REPORT_CAPTURE_INVALID'));
  });
  it.each(['09','31'] as const)('reads %s from its actual local numbered owner and reports transfer only',async type=>{
    const f=await withGuide(type),r=await f.core().execute(f.auth,'DASHBOARD',{filters:f.input.filters});
    expect(r.data.groups).toEqual([]);expect(r.data.netSales).toEqual([]);
    expect(r.data.transfers).toHaveLength(1);expect(r.data.transfers[0]).toMatchObject({type,grossWeight:'1.25',weightUnit:'KGM'});
    expect(r.data.transfers[0].quantities[0].quantity).toBe(type==='09'?'2.000001':'2.0000000001');
    expect(f.guideAuthority.current).toHaveBeenCalledWith(f.auth.token,'SERVICE',f.guideSnapshot.binding,'READ');
  });
  it.each(['09','31'] as const)('fails closed on %s receipt/physical bundle inconsistency',async type=>{
    const f=await withGuide(type);f.records[0].value.items=[];
    await expect(f.core().execute(f.auth,'CREATE',f.input)).rejects.toEqual(code('REPORT_CAPTURE_INVALID'));
    expect(f.store.jobs.size).toBe(0);
  });
  it.each(['07','08','NV','09','31'] as const)('exports %s as real CSV, XLSX and PDF with type-specific amounts',async type=>{
    const renderers=createReportsRenderers({Workbook,PdfDocument}),f=type==='09'||type==='31'?await withGuide(type,renderers):reportsSourcesFixture(renderers);
    const input=typeof f.input==='function'?f.input(type):f.input;
    const core=f.core();
    for(const format of ['CSV','XLSX','PDF']){
      const made=await core.execute(f.auth,'CREATE',{...input,format,idempotencyKey:'synthetic_source_format_'+type+'_'+format});
      const file=await core.execute(f.auth,'CONTENT',{id:made.data.id});
      if(format==='CSV'){
        const text=file.bytes.toString();expect(text).toContain('signedPayableAmount');
        if(type==='07')expect(text).toContain('"-118.00"');
        if(type==='09'||type==='31')expect(text).toContain('"TRANSFER"');
      }else if(format==='XLSX'){
        const w=new Workbook();await w.xlsx.load(file.bytes);const row=w.getWorksheet('Documents').getRow(2);
        expect(row.getCell(5).value).toBe(type);expect(row.getCell(16).value).toBe(type==='07'?'-118.00':type==='09'||type==='31'?'':'118.00');
        expect(row.getCell(16).type).toBe(3);if(type==='09'||type==='31')expect(w.getWorksheet('Transfers').rowCount).toBe(2);
      }else expect(file.bytes.subarray(0,5).toString()).toBe('%PDF-');
    }
  });
  it('rejects source grant revocation during download I/O',async()=>{
    const f=reportsSourcesFixture(),core=f.core(),made=await core.execute(f.auth,'CREATE',f.input('07')),transaction=f.store.transaction.bind(f.store);
    f.store.transaction=(key,work)=>transaction(key,tx=>work({...tx,content:async(o,id)=>{const file=await tx.content(o,id);f.control.revoked=true;return file;}}));
    await expect(core.execute(f.auth,'CONTENT',{id:made.data.id})).rejects.toEqual(code('TEST_REVOKED'));
  });
});
describe('B2B08 owner-local source SQL boundaries (no database connections)',()=>{
  it('uses read-only snapshot transactions and exact filters before limits for every source',async()=>{
    const f=reportsSourcesFixture(),access=f.records.map(r=>r.access),guide=await withGuide('31');
    const queries:{sql:string;values:any[]}[]=[];
    const db={query:vi.fn(async(sql:string,values:any[]=[])=>{queries.push({sql,values});return {rows:sql.startsWith('SELECT to_char')?[{at:'2026-10-25T12:00:00.000Z'}]:[],rowCount:0};}),release:vi.fn()};
    const source=new PostgresBillingReportSources({connect:async()=>db as any});
    await source.capture(f.p,reportsFilters(f.filters(),true),access);
    await source.capture(guide.p,reportsFilters(guide.input.filters,true),[guide.records[0].access]);
    expect(queries[0].sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const selects=queries.filter(q=>q.sql.includes('LIMIT'));expect(selects).toHaveLength(4);
    expect(selects.every(q=>q.sql.indexOf('WHERE')<q.sql.indexOf('LIMIT'))).toBe(true);
    expect(selects[0].sql).toContain('o."seriesCounterId"=$5');expect(selects[0].values.slice(0,5)).toEqual([1,f.p.bindings[0].issuerRuc,f.p.bindings[0].branchId,f.p.bindings[0].pointId,f.p.bindings[0].seriesId]);
    expect(selects[2].values.slice(0,2)).toEqual([f.p.clientId,'SERVICE:-']);expect(selects[3].sql).toContain("AT TIME ZONE 'America/Lima'");
    expect(queries.at(-1)?.sql).toBe('COMMIT');expect(db.release).toHaveBeenCalledTimes(2);
    expect(selects[0].sql).not.toContain('JournalEvent');
  });
  it('rolls back and masks database errors without leaking details',async()=>{
    const db={query:vi.fn(async(sql:string)=>{if(sql.startsWith('SELECT'))throw new Error('private database details');return {rows:[],rowCount:0};}),release:vi.fn()};
    const f=reportsSourcesFixture();
    await expect(new PostgresBillingReportSources({connect:async()=>db as any}).capture(f.p,reportsFilters(f.filters(),true),[])).rejects.toEqual(code('REPORT_SOURCE_UNAVAILABLE'));
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');expect(db.release).toHaveBeenCalledOnce();
  });

  it('validates source type, RUC, branch, series and scope again before opening its pool',async()=>{
    const f=reportsSourcesFixture(),connect=vi.fn(),store=new PostgresBillingReportSources({connect}),a=f.records[0].access;
    for(const filters of [
      {...f.filters('07'),issuerRuc:'20444444444'}, {...f.filters('07'),branchId:sourceId(77)},
      {...f.filters('07'),seriesId:sourceId(77)}, f.filters('08'),
    ]){
      await expect(store.capture(f.p,reportsFilters(filters,true),[a])).rejects.toEqual(code('RESOURCE_NOT_FOUND'));
    }
    f.p.scopes=f.p.scopes.filter(s=>s!=='b2b:corrections:read');
    await expect(store.capture(f.p,reportsFilters(f.filters('07'),true),[a])).rejects.toEqual(code('SCOPE_REQUIRED'));
    expect(connect).not.toHaveBeenCalled();
  });
  it('masks pool connection failures without exposing connection details',async()=>{
    const f=reportsSourcesFixture(),store=new PostgresBillingReportSources({connect:async()=>{throw new Error('private connection data');}});
    await expect(store.capture(f.p,reportsFilters(f.filters('07'),true),[f.records[0].access])).rejects.toEqual(code('REPORT_SOURCE_UNAVAILABLE'));
  });
});





