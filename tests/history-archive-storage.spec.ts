import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {HistoryArtifactStore} from '../services/history-service/src/artifact-store';
const f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
const owned:string[]=[];
function setup(){
  const work=fs.mkdtempSync(path.join(tmpdir(),'factuez-history-persist-qa-'));owned.push(work);
  const sourceRoot=path.join(work,'source'),archiveRoot=path.join(work,'archive'),markerId=f.uuid(1000);
  const marker=JSON.stringify({profile:'factuez-history-storage-qa-v1',markerId});
  for(const root of[sourceRoot,archiveRoot]){fs.mkdirSync(root);fs.writeFileSync(path.join(root,'.history-qa-marker.json'),marker);}
  const input=f.exported(1,true),d=input.documents[0],m=d.ownership;
  for(const a of d.artifacts){const target=path.join(sourceRoot,m.issuerRuc,m.documentTypeCode,m.series,d.number,a.kind,a.originalName);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,f.artifactBytes(a.kind));}
  return{work,sourceRoot,archiveRoot,markerId,input,store:new HistoryArtifactStore({sourceRoot,archiveRoot,markerId})};
}
afterEach(()=>{for(const dir of owned.splice(0)){expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()));expect(path.basename(dir)).toMatch(/^factuez-history-persist-qa-/);fs.rmSync(dir,{recursive:true,force:true});}});
describe('almacenamiento append-only exclusivamente ficticio',()=>{
  it('preserva nombres/hash/bytes; replay no sobrescribe originales',async()=>{
    const s=setup(),result=await s.store.stageBatch(s.input,0);expect(result).toHaveLength(1);expect(result[0].keys).toHaveLength(2);
    const before=result[0].keys.map(k=>fs.statSync(path.join(s.archiveRoot,k.key)).mtimeMs);
    expect(await s.store.stageBatch(s.input,0)).toEqual(result);
    expect(result[0].keys.map(k=>fs.statSync(path.join(s.archiveRoot,k.key)).mtimeMs)).toEqual(before);
    const data=await s.store.read(s.input.documents[0],'CDR_XML');expect(data.bytes).toEqual(f.artifactBytes('CDR_XML'));
    expect(data).toMatchObject({originalName:'ficticio.xml',fiscalAuthority:false,cdrAuthenticityVerified:false});
  });
  it('discrepancia de bytes fuente impide staging',async()=>{
    const s=setup(),d=s.input.documents[0],m=d.ownership,a=d.artifacts[0];
    fs.writeFileSync(path.join(s.sourceRoot,m.issuerRuc,m.documentTypeCode,m.series,d.number,a.kind,a.originalName),Buffer.alloc(a.sizeBytes,65));
    await expect(s.store.stageBatch(s.input,0)).rejects.toThrow(/ARTIFACT_HASH_MISMATCH/);
  });
  it('archivo destino alterado bloquea lectura y no se repara automáticamente',async()=>{
    const s=setup(),records=await s.store.stageBatch(s.input,0),key=records[0].keys.find(k=>k.kind==='CDR_XML')!.key;
    const target=path.join(s.archiveRoot,key),before=fs.readFileSync(target);fs.writeFileSync(target,Buffer.alloc(before.length,66));
    await expect(s.store.read(s.input.documents[0],'CDR_XML')).rejects.toThrow(/ARTIFACT_HASH_MISMATCH/);
    await expect(s.store.stageBatch(s.input,0)).rejects.toThrow(/ARTIFACT_HASH_MISMATCH/);
    expect(fs.readFileSync(target)).toEqual(Buffer.alloc(before.length,66));
  });
  it('marker incorrecto bloquea antes de copiar',async()=>{
    const s=setup();fs.writeFileSync(path.join(s.archiveRoot,'.history-qa-marker.json'),JSON.stringify({profile:'factuez-history-storage-qa-v1',markerId:f.uuid(1001)}));
    await expect(s.store.stageBatch(s.input,0)).rejects.toThrow(/STORAGE_MARKER_INVALID/);
    expect(fs.readdirSync(s.archiveRoot)).toEqual(['.history-qa-marker.json']);
  });
  it('junction de raíz no se sigue',async()=>{
    const s=setup(),moved=path.join(s.work,'moved');fs.renameSync(s.archiveRoot,moved);fs.symlinkSync(moved,s.archiveRoot,'junction');
    await expect(s.store.stageBatch(s.input,0)).rejects.toThrow(/UNSAFE_STORAGE_PATH/);
  });
  it('hardlink de destino se rechaza',async()=>{
    const s=setup(),records=await s.store.stageBatch(s.input,0),key=records[0].keys[0].key;
    fs.linkSync(path.join(s.archiveRoot,key),path.join(s.work,'linked.xml'));
    await expect(s.store.stageBatch(s.input,0)).rejects.toThrow(/UNSAFE_STORAGE_PATH/);
  });
  it('no acepta raíces reales ni rutas arbitrarias',()=>{
    expect(()=>new HistoryArtifactStore({sourceRoot:'D:/Facturacion/FactuEz/secrets',archiveRoot:'D:/Facturacion/FactuEz/data',markerId:f.uuid(1000)})).toThrow(/STORAGE_QA_ROOT_REQUIRED/);
  });
  it('no permite contenido sin marker o producción',async()=>{
    const s=setup();s.input.environment='PRODUCTION';await expect(s.store.stageBatch(s.input,0)).rejects.toThrow(/HISTORY_PROFILE_BLOCKED/);
    s.input.environment='BETA';fs.unlinkSync(path.join(s.sourceRoot,'.history-qa-marker.json'));await expect(s.store.stageBatch(s.input,0)).rejects.toThrow(/HISTORY_ARTIFACT_STORAGE_FAILED/);
  });
});
