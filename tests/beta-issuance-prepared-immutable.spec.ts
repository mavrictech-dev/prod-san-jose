import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {BetaIssuanceRepository} from '../services/sunat-service/src/application/beta-issuance.repository';

function fixture(type:'01'|'03'='01'){
 const xml={storageKey:'fake/doc.xml',sha256:'a'.repeat(64),sizeBytes:10};
 const zip={storageKey:'fake/doc.zip',sha256:'b'.repeat(64),sizeBytes:20};
 const manifest={fileName:'fake.zip',reference:'F001-1',revision:1,fingerprint:'c'.repeat(64),digest:'digest',xml,documentXml:xml,zip,
  ...(type==='03'?{documentZip:zip,requestOwnerId:'fake-summary'}:{}),xsdEvidence:{}};
 const row={id:'submission',documentId:'document',owner:new Date(),attempt:1,snapshot:{issuer:{identityNumber:'00000000001'},documentTypeCode:type}};
 const metadata={version:1,eventId:'event',correlationId:'correlation'};
 const docs=new Map([['SIGNED_XML',{...xml,mediaType:'application/xml'}],['SUBMISSION_ZIP',{...zip,mediaType:'application/zip'}]]);
 const batches=new Map([...docs.entries()].map(([k,v])=>[k,{...v}]));
 const tx={sunatSubmission:{findUniqueOrThrow:vi.fn(async()=>({batchId:'batch',errorMessage:JSON.stringify(metadata)})),updateMany:vi.fn(async()=>({count:1}))},
  sunatCredentials:{findUnique:vi.fn(async()=>({revision:1,certificateFingerprint:manifest.fingerprint}))},
  documentArtifact:{findUnique:vi.fn(async({where}:any)=>docs.get(where.documentId_kind.kind)),upsert:vi.fn()},
  batchArtifact:{findUnique:vi.fn(async({where}:any)=>batches.get(where.batchId_kind.kind)),upsert:vi.fn()},
  fiscalDocument:{update:vi.fn()}};
 const repository=new BetaIssuanceRepository({$transaction:async(fn:any)=>fn(tx)} as never);
 return {tx,docs,batches,manifest,row,metadata,repository};
}
describe('preparación Beta: identidad inmutable del manifiesto y artefactos',()=>{
 it.each(['01','03'] as const)('reutiliza los archivos idénticos para %s',async(type)=>{
  const f=fixture(type);expect(await f.repository.savePrepared(f.row as any,f.manifest)).toBe(true);
 });
 it.each(['storageKey','sizeBytes','mediaType','sha256'] as const)('rechaza cambio de %s en un archivo del comprobante',async(field)=>{
  const f=fixture();const old=f.docs.get('SIGNED_XML')!;f.docs.set('SIGNED_XML',{...old,[field]:field==='sizeBytes'?11:'diferente'});
  await expect(f.repository.savePrepared(f.row as any,f.manifest)).rejects.toThrow('No se modifica artefacto fiscal preparado');
 });
 it.each(['storageKey','sizeBytes','mediaType','sha256'] as const)('rechaza cambio de %s en un archivo de resumen',async(field)=>{
  const f=fixture('03');const old=f.batches.get('SIGNED_XML')!;f.batches.set('SIGNED_XML',{...old,[field]:field==='sizeBytes'?11:'diferente'});
  await expect(f.repository.savePrepared(f.row as any,f.manifest)).rejects.toThrow('No se modifica el artefacto de un RC reservado');
 });
 it('rechaza cambiar un manifiesto ya preparado antes de alterar la solicitud',async()=>{
  const f=fixture();f.tx.sunatSubmission.findUniqueOrThrow.mockResolvedValue({batchId:'batch',errorMessage:JSON.stringify({...f.metadata,prepared:{...f.manifest,digest:'otro'}})});
  await expect(f.repository.savePrepared(f.row as any,f.manifest)).rejects.toThrow('No se reemplaza paquete fiscal preparado');
  expect(f.tx.sunatSubmission.updateMany).not.toHaveBeenCalled();
 });
});
