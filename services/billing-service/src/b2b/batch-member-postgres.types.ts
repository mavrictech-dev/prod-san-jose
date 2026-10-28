import type { FiscalAcceptanceEvidence } from '@factuez/sunat-core/dist/fiscal-note';
import type { FiscalNotDeliveredEvidence } from '@factuez/sunat-core/dist/fiscal-batch';
import type { BatchMemberBinding, BatchMemberVersion, BatchOwnerMember, BatchSubject } from './batch-member-authority';

/** Private owner boundary, never a request DTO. Implementations MUST verify issuer signed XML
 * against the full snapshot and pinned trust, and accepted CDR signature/content/exact RC line
 * membership before returning acceptance. They must establish a complete owner credit catalogue
 * before admitting notes. No public accepted/complete flags or request certificate paths.
 * This candidate supplies storage, not a cryptographic verifier or a network client. */
export interface BatchMemberEvidencePort {
  verifySignedVersion(ownerHandle: string, asOf: string): Promise<{
    binding: BatchMemberBinding;
    snapshot: BatchOwnerMember['snapshot'];
    acceptance: FiscalAcceptanceEvidence | null;
    notDelivered: FiscalNotDeliveredEvidence | null;
    original: BatchMemberVersion | null;
    provenance: { verifierId: string; artifactId: string; verifiedAt: string;
      signedXmlSha256: string; cdrSha256: string | null; catalogueSha256: string };
  }>;
}

/** Fresh private Identity lookup; throws on denial. Identity is a separate authority: the last
 * successful lookup is a remote observation, NOT a cross-database atomic revocation protocol. */
export interface BatchMemberIdentityPort {
  current(subject: BatchSubject, asOf: string): Promise<{
    subject: BatchSubject; clientRevision: number; userAuthRevision: number | null; checkedAt: string;
  }>;
}

/** Mandatory private live step-up verifier. It must reject expired/revoked/non-admin sessions.
 * Receipts bind the exact policy digest, including expected revision and active=false revokes.
 * No default allow, public admin flag or caller-provided receipt is accepted. */
export interface BatchMemberPolicyAdminPort {
  authorizeStepUp(ownerAdminHandle: string, policySha256: string, asOf: string): Promise<{
    adminId: string; authRevision: number; policySha256: string; checkedAt: string;
  }>;
}

/** Explicit independent local policy; configured only by a trusted owner policy administrator.
 * expectedRevision=0 creates, otherwise compare-and-set; inactive grants retain their identity.
 * Identity scopes are never copied into this table automatically. */
export type BatchLocalGrantPolicy = {
  subject: BatchSubject; binding: BatchMemberBinding; kind: 'RC' | 'RA'; permission: 'READ' | 'WRITE';
  clientRevision: number; userAuthRevision: number | null; active: boolean; expectedRevision: number;
};

/** Structural pg contract avoids introducing a new dependency or generated database client. */
export interface BatchSqlConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(destroy?: boolean): void;
}
export interface BatchSqlPool { connect(): Promise<BatchSqlConnection> }

/** Callback capability exposes only the dedicated local producer, never the raw SQL connection. */
export interface BatchLocalProducerTransaction {
  persist(prepared: import('./batch-member-authority').BatchPrepared): Promise<{
    batchId: string; eventId: string; identifier: string; state: 'PREPARED'; localOnly: true;
    fiscalExecutionEnabled: false; officialAcceptance: false;
  }>;
}
