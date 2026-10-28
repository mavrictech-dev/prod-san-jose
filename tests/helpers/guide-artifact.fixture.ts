import { vi } from 'vitest';
import { GuideArtifactPipeline, type GuideArtifactRecord, type GuideArtifactStore, type GuideCdrArchive } from '../../services/sunat-service/src/application/guide-artifact-pipeline';
import { signLocalGuideXml } from '../../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import type { GuideArtifactOwned } from '../../services/sunat-service/src/application/guide-artifact-owner';
import { guideIssueFixture } from './guide-issue.fixture';
import type { createGuideSidecarPki } from './guide-sidecar-ephemeral-pki.fixture';

const copy = (r: GuideArtifactRecord | null) => r && ({ ...r, metadata: structuredClone(r.metadata), zip: Buffer.from(r.zip) });
const copyCdr = (r: GuideCdrArchive | null) => r && ({ ...r, evidence: structuredClone(r.evidence), zip: Buffer.from(r.zip) });
/** Serializable memory double. The separate PostgreSQL runner tests physical
 * append-only constraints; this fixture never pretends to be a production DB. */
export async function guideArtifactFixture(pki: ReturnType<typeof createGuideSidecarPki>) {
  const f = guideIssueFixture(), result = await f.issue();
  const scope = { binding: f.binding, draftId: f.request.draftId, operationId: result.receipt.id };
  const issuance = { schemaVersion: 'factuez.b2b.guide-issuance.v1' as const, operationId: result.receipt.id, draftId: scope.draftId,
    binding: f.binding, snapshot: result.receipt.snapshot, snapshotSha256: result.receipt.snapshotSha256, replayed: null };
  const owned: GuideArtifactOwned = { issuance: issuance as GuideArtifactOwned['issuance'], authorizationSha256: 'a'.repeat(64) };
  const control = { revoked: false, writes: 0, cdrWrites: 0 }, hooks: { insert?: () => void; signed?: () => void } = {};
  const owner = { current: vi.fn(async () => { if (control.revoked) throw new Error('SYNTHETIC_REVOKED'); return structuredClone(owned); }) };
  const state = { artifact: null as GuideArtifactRecord | null, cdr: null as GuideCdrArchive | null };
  let queue = Promise.resolve();
  const store: GuideArtifactStore = { transaction: async (_scope, work) => {
    const prev = queue; let release!: () => void; queue = new Promise<void>(r => { release = r; }); await prev;
    const staged = { artifact: copy(state.artifact), cdr: copyCdr(state.cdr) };
    try {
      const value = await work({ read: async () => copy(staged.artifact),
        insert: async r => { if (staged.artifact) throw new Error('SYNTHETIC_CONFLICT'); staged.artifact = copy(r); hooks.insert?.(); },
        readCdr: async () => copyCdr(staged.cdr), insertCdr: async r => { if (staged.cdr) throw new Error('SYNTHETIC_CONFLICT'); staged.cdr = copyCdr(r); } });
      if (!state.artifact && staged.artifact) control.writes++;
      if (!state.cdr && staged.cdr) control.cdrWrites++;
      state.artifact = staged.artifact; state.cdr = staged.cdr; return value;
    } finally { release(); }
  } };
  const signer = { mode: 'ISOLATED_LOCAL_SIGNER' as const, sign: vi.fn(async input => {
    const r = signLocalGuideXml(input, pki.issuer.pkcs12, pki.password); hooks.signed?.(); return r;
  }) };
  const access = { token: 'synthetic-artifact-access', kind: 'SERVICE' as const };
  const verifier = { verify: vi.fn(pki.cdrVerifier.verify) };
  const core = () => new GuideArtifactPipeline(owner, store, signer, [f.binding.draft.anchor.issuerRuc], verifier, () => '2026-10-23T16:00:00.000Z');
  return { f, scope, owned, owner, state, store, signer, access, verifier, control, hooks, core: core(), restart: core };
}
