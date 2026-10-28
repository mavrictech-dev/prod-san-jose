import 'reflect-metadata';
import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { OriginalArtifactReader } from '../services/sunat-service/src/integration/artifact-reader';
import { artifactId,documentId,secondId } from './integration-read.fixture';
describe('Bounded original file reads, task-owned temporary fixture only',()=>{
  let root:string,reader:OriginalArtifactReader;const bytes=Buffer.from('<fiction/>');
  const metadata=()=>({id:artifactId,kind:'SIGNED_XML',storageKey:documentId+'/fixture.xml',mediaType:'application/xml',
    sizeBytes:BigInt(bytes.length),sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date()});
  beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'factuez-i4-store-'));reader=new OriginalArtifactReader(root);
    await mkdir(join(root,documentId));await writeFile(join(root,documentId,'fixture.xml'),bytes,{flag:'wx'});});
  afterAll(async()=>{
    // Never delete a computed broad/user path: validate the exact generated task-owned directory.
    const child=relative(resolve(tmpdir()),resolve(root));
    if (!child || isAbsolute(child) || child.includes('/') || child.includes('\\') || !/^factuez-i4-store-[A-Za-z0-9]+$/.test(child)) throw new Error('Unsafe fixture cleanup');
    await rm(root,{recursive:true,force:false});
  });
  it('returns exact original bytes without creating any renderer cache',async()=>expect(await reader.read(documentId,metadata())).toEqual(bytes));
  it.each(['../outside.xml',secondId+'/file.xml',documentId+'/../../outside.xml',documentId])('denies path/owner escape %s',async storageKey=>{
    await expect(reader.read(documentId,{...metadata(),storageKey})).rejects.toThrow();
  });
  it.each([0,-1,10485761,Number.MAX_SAFE_INTEGER,1.5])('rejects invalid/beyond-bound size %s before read',async sizeBytes=>{
    await expect(reader.read(documentId,{...metadata(),sizeBytes})).rejects.toThrow();
  });
  it('rejects metadata length disagreement',async()=>await expect(reader.read(documentId,{...metadata(),sizeBytes:1})).rejects.toThrow());
  it('rejects digest disagreement',async()=>await expect(reader.read(documentId,{...metadata(),sha256:'a'.repeat(64)})).rejects.toThrow());
  it('does not substitute a missing XML',async()=>await expect(reader.read(documentId,{...metadata(),storageKey:documentId+'/missing.xml'})).rejects.toThrow());
  it('requires explicit absolute root and UUID owner',async()=>{
    expect(()=>new OriginalArtifactReader('relative/path')).toThrow();await expect(reader.read('admin',metadata())).rejects.toThrow();
  });
});
