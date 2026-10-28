import { describe,it,expect,afterEach } from 'vitest';
import { B2bHistoryReads,SyntheticB2bHistoryArchive } from '../services/history-service/src/b2b';
import { historyFixture } from './b2b-phase8-reports-history.fixture';
const code=(c:string)=>expect.objectContaining({code:c});
const active:ReturnType<typeof historyFixture>[]=[];
function setup(){const f=historyFixture();active.push(f);return f;}
afterEach(()=>{for(const f of active.splice(0))f.close();});
describe('B2B08 independent synthetic historical archive',()=>{
  it('disabled by default and closed without archive configuration',async()=>{
    const f=setup();await expect(new B2bHistoryReads(f.identity,f.archive).execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('HISTORY_B2B_DISABLED'));
    const r=new B2bHistoryReads(f.identity,null,{enabled:true,environment:'BETA',datasetClass:'SYNTHETIC'});
    await expect(r.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('HISTORY_ARCHIVE_PORT_REQUIRED'));
  });
  it('real archive service lists with exact RUC/branch/type and assigned point/series',async()=>{
    const f=setup(),r=await f.reader.execute(f.auth,'LIST',{binding:f.binding});expect(r).toMatchObject({datasetClass:'SYNTHETIC',fiscalAuthority:false,data:{nextCursor:null}});
    expect(r.data.items).toHaveLength(1);expect(f.tx.historyRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{issuerRuc:f.binding.issuerRuc,branchId:f.binding.branchId,
      documentTypeCode:f.binding.documentType,emissionPointId:{in:[f.binding.pointId]},seriesCounterId:{in:[f.binding.seriesId]}},take:25}));
  });
  it('details omit private storage keys, content uses real protected artifact store',async()=>{
    const f=setup(),r=await f.reader.execute(f.auth,'DETAIL',{binding:f.binding,recordId:f.recordId});expect(r.data.snapshot).toBeDefined();expect(r.data.artifactKeys).toBeUndefined();
    const file=await f.reader.execute(f.auth,'CONTENT',{binding:f.binding,recordId:f.recordId,artifactKind:'SIGNED_XML'});
    expect(file.mediaType).toBe('application/xml');expect(Buffer.isBuffer(file.bytes)).toBe(true);expect(file.sha256).toBe(f.row.snapshot.artifacts.find((a:any)=>a.kind==='SIGNED_XML').sha256);
    expect(JSON.stringify(r)).not.toContain(f.auth.token);expect(f.permission.authorizeCurrent.mock.calls.every(c=>!JSON.stringify(c).includes(f.auth.token))).toBe(true);
  });
  it('scope alone never enrolls into archive and missing permission port is closed',async()=>{
    const f=setup();f.unenroll();await expect(f.reader.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('HISTORY_ARCHIVE_NOT_ENROLLED'));expect(f.prisma.$transaction).not.toHaveBeenCalled();
    const archive=new SyntheticB2bHistoryArchive(f.repository,f.artifacts,null),reader=new B2bHistoryReads(f.identity,archive,{enabled:true,environment:'BETA',datasetClass:'SYNTHETIC'});
    await expect(reader.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('HISTORY_ARCHIVE_PERMISSION_PORT_REQUIRED'));
  });
  it('requires history scope and content artifact scope separately',async()=>{
    const f=setup();f.p.scopes=['b2b:history:read'];await expect(f.reader.execute(f.auth,'CONTENT',{binding:f.binding,recordId:f.recordId,artifactKind:'SIGNED_XML'})).rejects.toEqual(code('SCOPE_REQUIRED'));
    expect((await f.reader.execute(f.auth,'LIST',{binding:f.binding})).data.items).toHaveLength(1);f.p.scopes=['b2b:artifacts:read'];
    await expect(f.reader.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('SCOPE_REQUIRED'));
  });
  it('rejects foreign full binding before archive lookup',async()=>{
    const f=setup();await expect(f.reader.execute(f.auth,'LIST',{binding:{...f.binding,seriesId:'00000000-0000-4000-8000-000000000099'}})).rejects.toEqual(code('RESOURCE_NOT_FOUND'));
    expect(f.permission.authorizeCurrent).not.toHaveBeenCalled();
  });
  it('rejects GLOBAL/import or cross-product archive actor grants',async()=>{
    const f=setup();f.decision.actor={...f.decision.actor,roles:['ADMIN'],scope:{kind:'GLOBAL'}};
    await expect(f.reader.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('HISTORY_ARCHIVE_SCOPE_DENIED'));
    f.decision.actor={...f.decision.actor,scope:{kind:'ASSIGNED',branchIds:[f.binding.branchId],emissionPointIds:[f.binding.pointId],seriesCounterIds:[f.binding.seriesId,'00000000-0000-4000-8000-000000000099']}};
    await expect(f.reader.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('HISTORY_ARCHIVE_SCOPE_DENIED'));
  });
  it('detects live identity and enrollment changes during I/O',async()=>{
    const f=setup();f.tx.historyRecord.findMany.mockImplementationOnce(async()=>{f.p.revision++;return [f.row];});
    await expect(f.reader.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('ACCESS_CHANGED'));f.p.revision--;
    f.tx.historyRecord.findMany.mockImplementationOnce(async()=>{f.decision.revision='2';return [f.row];});
    await expect(f.reader.execute(f.auth,'LIST',{binding:f.binding})).rejects.toEqual(code('HISTORY_ARCHIVE_ACCESS_CHANGED'));
  });
  it('blocks artifact bytes when archive I/O revokes live B2B identity',async()=>{
    const f=setup(),read=f.artifacts.read.bind(f.artifacts);
    f.artifacts.read=async(snapshot,kind)=>{const file=await read(snapshot,kind);f.p.revision++;return file;};
    await expect(f.reader.execute(f.auth,'CONTENT',{binding:f.binding,recordId:f.recordId,artifactKind:'SIGNED_XML'})).rejects.toEqual(code('ACCESS_CHANGED'));
  });
  it('preserves original synthetic marker and reader-role guards',async()=>{
    const f=setup();f.tx.historySandbox.findUnique.mockResolvedValue({});await expect(f.reader.execute(f.auth,'DETAIL',{binding:f.binding,recordId:f.recordId})).rejects.toThrow(/SANDBOX_MARKER_MISMATCH/);
    f.tx.$queryRaw.mockResolvedValue([{database:'factuez_history_qa_aabbccddee',role:'history_import_qa'}]);
    await expect(f.reader.execute(f.auth,'DETAIL',{binding:f.binding,recordId:f.recordId})).rejects.toThrow(/SANDBOX_READER_REQUIRED/);
  });
  it('refuses real RUC coverage and malformed public inputs',async()=>{
    const f=setup();const real={...f.binding,issuerRuc:'20555555555'};f.p.bindings=[real];
    await expect(f.reader.execute(f.auth,'LIST',{binding:real})).rejects.toEqual(code('HISTORY_SYNTHETIC_PROFILE_REQUIRED'));
    await expect(f.reader.execute(f.auth,'LIST',{binding:real,take:101})).rejects.toEqual(code('INVALID_QUERY'));
    await expect(f.reader.execute(f.auth,'LIST',{binding:real,issuerRuc:'00000000001'}as any)).rejects.toEqual(code('INVALID_REQUEST'));
  });
});