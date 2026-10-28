import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertHistory, HistoryError, HISTORY_FULL_LIMITS, historyInteger, historyJson, historyObject, historyUuid,
  prepareHistoricalImport, validateHistoricalSnapshot, type HistoricalArtifact } from '@factuez/history-core';
import type { StoredArtifactKeys } from './repository';

type Snapshot = fs.BigIntStats;
function same(a:Snapshot,b:Snapshot) { return a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs && a.nlink===b.nlink; }
/** Append-only fixture storage. Never overwrites/deletes, signs, unzips or parses XML. */
export class HistoryArtifactStore {
  private readonly sourceRoot:string;
  private readonly archiveRoot:string;
  private readonly markerId:string;
  constructor(configInput:unknown) {
    const c=historyJson(configInput); historyObject(c,['sourceRoot','archiveRoot','markerId']); this.markerId=historyUuid(c.markerId);
    this.sourceRoot=this.rootName(c.sourceRoot,'source'); this.archiveRoot=this.rootName(c.archiveRoot,'archive');
    assertHistory(path.dirname(this.sourceRoot)===path.dirname(this.archiveRoot),'STORAGE_SCOPE_MISMATCH');
  }
  private rootName(value:unknown,kind:'source'|'archive') {
    assertHistory(typeof value==='string' && value===value.trim() && !value.includes('\0') && !value.includes('://') && !/^(\\\\|\/\/)/.test(value),'INVALID_STORAGE_ROOT');
    const resolved=path.resolve(value);
    assertHistory(/^factuez-history-persist-qa-[a-zA-Z0-9]+$/.test(path.basename(path.dirname(resolved))) &&
      (kind==='source'?path.basename(resolved)==='source':['archive','archive-restore'].includes(path.basename(resolved))),'STORAGE_QA_ROOT_REQUIRED');
    return resolved;
  }
  private directory(target:string) {
    const stat=fs.lstatSync(target,{bigint:true});
    assertHistory(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(target)===target,'UNSAFE_STORAGE_PATH'); return stat;
  }
  private file(target:string) {
    const stat=fs.lstatSync(target,{bigint:true});
    assertHistory(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&fs.realpathSync(target)===target,'UNSAFE_STORAGE_PATH'); return stat;
  }
  private marker(root:string) {
    this.directory(root); const name=path.join(root,'.history-qa-marker.json'), stat=this.file(name);
    assertHistory(stat.size>0n&&stat.size<=512n,'STORAGE_MARKER_INVALID');
    const fd=fs.openSync(name,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try {
      assertHistory(same(stat,fs.fstatSync(fd,{bigint:true})),'STORAGE_MARKER_INVALID');
      const bytes=Buffer.alloc(Number(stat.size)+1),length=fs.readSync(fd,bytes,0,bytes.length,0);
      assertHistory(BigInt(length)===stat.size&&same(stat,fs.fstatSync(fd,{bigint:true}))&&same(stat,this.file(name)),'STORAGE_MARKER_INVALID');
      const m=historyJson(JSON.parse(bytes.subarray(0,length).toString('utf8')));
      historyObject(m,['profile','markerId']); assertHistory(m.profile==='factuez-history-storage-qa-v1'&&m.markerId===this.markerId,'STORAGE_MARKER_INVALID');
    } finally { fs.closeSync(fd); }
  }
  private target(root:string,components:string[],create=false) {
    this.marker(root);
    let current=root;
    for (const component of components.slice(0,-1)) {
      assertHistory(component.length>0&&!/[\\/:]/.test(component)&&component!=='.'&&component!=='..','UNSAFE_STORAGE_PATH');
      current=path.join(current,component);
      if(create) { try { fs.mkdirSync(current,{mode:0o750}); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; } }
      this.directory(current);
    }
    const target=path.resolve(current,components.at(-1)!);
    assertHistory(path.relative(root,target)!==''&&!path.relative(root,target).startsWith('..')&&!path.isAbsolute(path.relative(root,target)),'UNSAFE_STORAGE_PATH');
    return target;
  }
  private verifiedBytes(target:string,artifact:HistoricalArtifact):Buffer {
    const before=this.file(target); assertHistory(before.size===BigInt(artifact.sizeBytes)&&artifact.sizeBytes<=HISTORY_FULL_LIMITS.artifactBytes,'ARTIFACT_SIZE_MISMATCH');
    const fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try {
      assertHistory(same(before,fs.fstatSync(fd,{bigint:true})),'ARTIFACT_CHANGED');
      const bytes=Buffer.alloc(artifact.sizeBytes+1); let length=0,count;
      while(length<bytes.length&&(count=fs.readSync(fd,bytes,length,Math.min(64*1024,bytes.length-length),null))>0) length+=count;
      assertHistory(length===artifact.sizeBytes&&same(before,fs.fstatSync(fd,{bigint:true}))&&same(before,this.file(target)),'ARTIFACT_CHANGED');
      const result=bytes.subarray(0,length);
      assertHistory(createHash('sha256').update(result).digest('hex')===artifact.sha256,'ARTIFACT_HASH_MISMATCH'); return result;
    } finally { fs.closeSync(fd); }
  }
  async stageBatch(input:unknown,indexInput:unknown):Promise<StoredArtifactKeys> {
    try {
      const plan=prepareHistoricalImport(input), index=historyInteger(indexInput,plan.batches.length-1,0), result=[];
      this.marker(this.sourceRoot); this.marker(this.archiveRoot);
      for(const record of plan.batches[index].records) {
        const keys=[];
        for(const artifact of record.snapshot.artifacts) {
          const d=record.snapshot,m=d.ownership;
          const sourceParts=[m.issuerRuc,m.documentTypeCode,m.series,d.number,artifact.kind,artifact.originalName];
          const source=this.target(this.sourceRoot,sourceParts), bytes=this.verifiedBytes(source,artifact);
          const parts=[record.snapshotSha256,artifact.kind,artifact.originalName], target=this.target(this.archiveRoot,parts,true);
          // Exclusive create: a failed transaction may leave unreferenced files.
          // They are NEVER silently deleted/overwritten; retry verifies exact bytes.
          try { fs.writeFileSync(target,bytes,{flag:'wx',mode:0o640}); }
          catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
          this.target(this.sourceRoot,sourceParts); this.target(this.archiveRoot,parts);
          this.verifiedBytes(source,artifact); this.verifiedBytes(target,artifact);
          keys.push({kind:artifact.kind,key:parts.join('/')});
        }
        result.push({recordId:record.recordId,snapshotSha256:record.snapshotSha256,keys});
      }
      return result;
    } catch(error) { throw error instanceof HistoryError?error:new HistoryError('HISTORY_ARTIFACT_STORAGE_FAILED'); }
  }
  async read(snapshotInput:unknown,kind:unknown) {
    try {
      const snapshot=validateHistoricalSnapshot(snapshotInput),artifact=snapshot.artifacts.find(a=>a.kind===kind);
      assertHistory(artifact,'ARTIFACT_NOT_FOUND');
      // A minimal one-document plan derives the SAME canonical snapshot digest.
      const plan=prepareHistoricalImport({schemaVersion:'factuez.history-full.v1',environment:'BETA',datasetClass:'SYNTHETIC',
        exportId:'00000000-0000-4000-8000-000000000001',originSystem:'RESTOAPP',mappings:[snapshot.ownership],documents:[snapshot]});
      const parts=[plan.records[0].snapshotSha256,artifact.kind,artifact.originalName], target=this.target(this.archiveRoot,parts);
      const bytes=this.verifiedBytes(target,artifact); this.target(this.archiveRoot,parts);
      return {originalName:artifact.originalName,sha256:artifact.sha256,sizeBytes:artifact.sizeBytes,bytes,
        fiscalAuthority:false as const,cdrAuthenticityVerified:false as const};
    } catch(error) { throw error instanceof HistoryError?error:new HistoryError('HISTORY_ARTIFACT_STORAGE_FAILED'); }
  }
}
