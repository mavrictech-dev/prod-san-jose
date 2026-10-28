import {
  projectFiscalFinancialLedger,
  type FiscalFinancialLedgerInput, type FiscalFinancialLedgerProjection,
} from '@factuez/sunat-core/dist/fiscal-financial-ledger';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';

/** Server-only candidate for persistence. Checkpoints describe the caller's
 * expected stored heads; an atomic repository must compare them with storage.
 * Validation neither persists state nor verifies PKI or authorizes transmission.
 */
export type FinancialLedgerPlan = {
  planId: string;
  input: FiscalFinancialLedgerInput;
  expectedHeads: Array<{
    documentId: string;
    revision: number;
    sequence: number;
    versionSha256: string | null;
  }>;
};

export type FinancialLedgerPlanValidationResult = {
  plan: FinancialLedgerPlan;
  projection: Extract<FiscalFinancialLedgerProjection, { ok: true }>;
  inputSha256: string;
  planSha256: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(): never {
  const error = new Error('Plan de persistencia financiera inválido');
  delete error.stack;
  throw error;
}

/** Only used on the detached JSON returned by boundedSupplementJson. */
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) fail();
}

function counter(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
}

/** Traverse only detached JSON and the pure projection, never caller objects. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

/** Pure validation of a bounded, detached, deeply frozen candidate and result.
 * Runtime immutability preserves the server-computed hashes across awaits.
 * Evidence booleans remain simulation assertions, never proof of authenticity.
 * Every failure has the same message, with no input values, cause or stack.
 */
export function validateFinancialLedgerPlan(value: unknown): FinancialLedgerPlanValidationResult {
  try {
    // This trust boundary must precede reflection or property reads on value.
    const candidate = boundedSupplementJson(value);
    exact(candidate, ['planId', 'input', 'expectedHeads']);
    uuid(candidate.planId);
    if (!Array.isArray(candidate.expectedHeads) || candidate.expectedHeads.length > 100) fail();

    const headIds = new Set<string>();
    for (const head of candidate.expectedHeads) {
      exact(head, ['documentId', 'revision', 'sequence', 'versionSha256']);
      uuid(head.documentId);
      counter(head.revision);
      counter(head.sequence);
      if (head.versionSha256 === null) {
        if (head.revision !== 0 || head.sequence !== 0) fail();
      } else if (typeof head.versionSha256 !== 'string' || !SHA256.test(head.versionSha256)) fail();
      if (headIds.has(head.documentId)) fail();
      headIds.add(head.documentId);
    }

    const input = candidate.input as FiscalFinancialLedgerInput;
    const projection = projectFiscalFinancialLedger(input);
    if (!projection.ok || projection.simulationOnly !== true || projection.evidenceAuthenticityVerified !== false) fail();
    if (headIds.size !== input.documents.length || input.documents.some(document => !headIds.has(document.documentId))) fail();

    const plan = candidate as FinancialLedgerPlan;
    return deepFreeze({
      plan, projection,
      inputSha256: fiscalSnapshotSha256(plan.input),
      // All three exact fields participate, including every supplied checkpoint.
      planSha256: fiscalSnapshotSha256(plan),
    });
  } catch {
    return fail();
  }
}
