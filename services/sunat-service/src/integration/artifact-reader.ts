import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { uuid } from '@factuez/service-access/dist/integration';
import type { StoredArtifact } from './read';
/** Read-only bounded original reader. No mkdir, renderer, signer, fallback or deletion. */
export class OriginalArtifactReader {
  private readonly root:string;
  constructor(root:string) {if (!isAbsolute(root)) throw new Error('Absolute owner root required');this.root=resolve(root);}
  async read(ownerId:string,artifact:StoredArtifact) {
    const size=Number(artifact.sizeBytes);
    if (!uuid(ownerId) || !Number.isSafeInteger(size) || size<1 || size>10*1024*1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid original metadata');
    const path=resolve(this.root,artifact.storageKey),directory=join(this.root,ownerId);
    const child=relative(directory,path);
    if (!child || child==='..' || child.startsWith('..'+sep) || isAbsolute(child)) throw new Error('Invalid owner binding');
    const root=await realpath(this.root),actualDirectory=await realpath(directory);
    if (actualDirectory!==join(root,ownerId) || (await lstat(directory)).isSymbolicLink()) throw new Error('Invalid owner directory');
    const resolvedFile=await realpath(path);
    if (resolvedFile!==join(actualDirectory,child) || (await lstat(path)).isSymbolicLink()) throw new Error('Invalid original path');
    const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const before=await handle.stat();if (!before.isFile() || before.size!==size) throw new Error('Invalid original length');
      const bytes=Buffer.alloc(size);let offset=0;
      while(offset<size) {const part=await handle.read(bytes,offset,size-offset,offset);if (!part.bytesRead) throw new Error('Truncated original');offset+=part.bytesRead;}
      const extra=await handle.read(Buffer.alloc(1),0,1,size),after=await handle.stat();
      if (extra.bytesRead || after.size!==size || after.mtimeMs!==before.mtimeMs || after.ino!==before.ino ||
        createHash('sha256').update(bytes).digest('hex')!==artifact.sha256) throw new Error('Original integrity failed');
      return bytes;
    } finally {await handle.close();}
  }
}
