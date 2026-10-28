import { isAbsolute, join, parse, resolve } from 'node:path';
import { ArtifactStore, MAX_ARTIFACT_BYTES } from '../infrastructure/artifact-store';
import type { BatchMemberArtifactPort } from './batch-member-evidence';
import type { BetaAcceptanceArtifact } from './beta-document-acceptance';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Read-only adapter for existing content-addressed ArtifactStore files. A protected,
 * dedicated root and its ancestors must not be writable by an untrusted actor while
 * reading: ArtifactStore's path checks are not atomic against directory replacement.
 * Metadata must come from a separately authorized exact historical owner version.
 * This does not establish provenance, historical immutability, XML signature or acceptance. */
export function createHistoricalSignedArtifactReader(root: string): BatchMemberArtifactPort {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) === parse(resolve(root)).root)
    throw new Error('HISTORICAL_ARTIFACT_ROOT_INVALID');
  const store = new ArtifactStore(resolve(root));
  return Object.freeze({
    async read(documentId: string, artifact: BetaAcceptanceArtifact): Promise<Buffer> {
      try {
        if (!UUID.test(documentId) || !artifact || typeof artifact !== 'object' ||
            !UUID.test(artifact.id) || !HASH.test(artifact.sha256) ||
            !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > MAX_ARTIFACT_BYTES ||
            typeof artifact.storageKey !== 'string') throw new Error();
        // Only the exact layout created by ArtifactStore.put is admitted. No nested
        // directories, alternate document, absolute paths, links by arbitrary name or URLs.
        const prefix = `${artifact.sha256}-`;
        const directory = `${documentId}${process.platform === 'win32' ? '\\' : '/'}`;
        if (!artifact.storageKey.startsWith(directory)) throw new Error();
        const name = artifact.storageKey.slice(directory.length);
        if (!name.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,120}\.(xml|zip)$/.test(name.slice(prefix.length)) ||
            artifact.storageKey !== join(documentId, name)) throw new Error();
        return await store.read(documentId, { storageKey: artifact.storageKey, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes });
      } catch {
        // Neither paths nor underlying filesystem errors escape this private port.
        throw new Error('HISTORICAL_ARTIFACT_UNAVAILABLE');
      }
    },
  });
}
