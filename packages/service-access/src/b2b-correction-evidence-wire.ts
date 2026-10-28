/** Read-only candidate wire contract. A valid envelope is not a PKI assertion or fiscal authorization. */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { B2bSecurityError, validB2bCorrectionBinding, type B2bCorrectionBinding } from '@factuez/contracts/b2b-security';

export type CorrectionEvidenceAction = 'ORIGINAL' | 'PREREQUISITES' | 'OUTCOME';
export type CorrectionEvidenceRequest = {
  schemaVersion: 'factuez.b2b.correction-evidence-request.v1';
  requestId: string;
  kind: 'SERVICE' | 'USER';
  action: CorrectionEvidenceAction;
  binding: B2bCorrectionBinding;
  asOf: string;
  payload: unknown;
};
export type CorrectionEvidenceResponse = {
  schemaVersion: 'factuez.b2b.correction-evidence-response.v1';
  requestId: string;
  requestSha256: string;
  checkedAt: string;
  verifiedAt: string;
  authoritySha256: string;
  result: unknown;
  candidateOnly: true;
  fiscalExecutionEnabled: false;
  transmissionAuthorized: false;
};

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 100000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
type Failure = () => never;
const invalidRequest: Failure = () => { throw new B2bSecurityError(400, 'INVALID_EVIDENCE_REQUEST'); };
const invalidResponse: Failure = () => { throw new B2bSecurityError(503, 'INVALID_EVIDENCE_RESPONSE'); };

/** No property access, JSON hook or proxy trap runs before the input has been inspected. */
function detachedJson(value: unknown, fail: Failure): unknown {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  const charge = (size: number) => { bytes += size; if (bytes > MAX_BYTES) fail(); };
  const quoted = (text: string) => {
    if (text.length > MAX_BYTES) fail();
    charge(Buffer.byteLength(JSON.stringify(text), 'utf8'));
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > 32) fail();
    if (item === null) { charge(4); return null; }
    if (typeof item === 'boolean') { charge(item ? 4 : 5); return item; }
    if (typeof item === 'string') { quoted(item); return item; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail();
      charge(JSON.stringify(item).length); return item === 0 ? 0 : item;
    }
    if (!item || typeof item !== 'object' || isProxy(item) || ancestors.has(item)) fail();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail();
    if (array && item.length > MAX_NODES) fail();
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES) fail();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    ancestors.add(item);
    charge(2);
    if (array) {
      if (keys.length !== item.length + 1) fail();
      const output: unknown[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        if (index) charge(1);
        output.push(visit(descriptor.value, depth + 1));
      }
      ancestors.delete(item);
      return Object.freeze(output);
    }
    const output: Record<string, unknown> = {};
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      if (index) charge(1);
      quoted(key); charge(1);
      Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(item);
    return Object.freeze(output);
  };
  return visit(value, 0);
}

function exact(value: unknown, keys: readonly string[], fail: Failure): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) fail();
}
function timestamp(value: unknown, fail: Failure): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !==
      (value.includes('.') ? value : value.slice(0, -1) + '.000Z')) fail();
  return milliseconds;
}
function requestValue(input: unknown, fail: Failure): CorrectionEvidenceRequest {
  const value = detachedJson(input, fail);
  exact(value, ['schemaVersion', 'requestId', 'kind', 'action', 'binding', 'asOf', 'payload'], fail);
  if (value.schemaVersion !== 'factuez.b2b.correction-evidence-request.v1' ||
      typeof value.requestId !== 'string' || !UUID.test(value.requestId) ||
      typeof value.kind !== 'string' || !['SERVICE', 'USER'].includes(value.kind) ||
      typeof value.action !== 'string' || !['ORIGINAL', 'PREREQUISITES', 'OUTCOME'].includes(value.action)) fail();
  // The shared validator is only called on detached JSON; map malformed nested types to a safe wire error too.
  try { if (!validB2bCorrectionBinding(value.binding)) fail(); } catch { fail(); }
  timestamp(value.asOf, fail);
  return value as CorrectionEvidenceRequest;
}
export function correctionEvidenceRequest(input: unknown): CorrectionEvidenceRequest {
  return requestValue(input, invalidRequest);
}
export function correctionEvidenceFreeze<T>(value: T): T {
  return detachedJson(value, invalidRequest) as T;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function correctionEvidenceHash(value: unknown): string {
  return createHash('sha256').update(canonical(detachedJson(value, invalidRequest))).digest('hex');
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function responseValue(input: unknown, request: CorrectionEvidenceRequest): CorrectionEvidenceResponse {
  const value = detachedJson(input, invalidResponse);
  exact(value, ['schemaVersion', 'requestId', 'requestSha256', 'checkedAt', 'verifiedAt', 'authoritySha256', 'result',
    'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized'], invalidResponse);
  if (value.schemaVersion !== 'factuez.b2b.correction-evidence-response.v1' || value.requestId !== request.requestId ||
      value.requestSha256 !== hash(request) || value.checkedAt !== request.asOf ||
      typeof value.authoritySha256 !== 'string' || !SHA256.test(value.authoritySha256) ||
      value.candidateOnly !== true || value.fiscalExecutionEnabled !== false || value.transmissionAuthorized !== false) invalidResponse();
  if (timestamp(value.verifiedAt, invalidResponse) < timestamp(request.asOf, invalidResponse)) invalidResponse();
  return value as CorrectionEvidenceResponse;
}
export function correctionEvidenceResponse(request: CorrectionEvidenceRequest, authoritySha256: string,
  result: unknown, verifiedAt: string): CorrectionEvidenceResponse {
  const validated = requestValue(request, invalidResponse);
  return responseValue({ schemaVersion: 'factuez.b2b.correction-evidence-response.v1', requestId: validated.requestId,
    requestSha256: hash(validated), checkedAt: validated.asOf, verifiedAt, authoritySha256, result,
    candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false }, validated);
}
export function verifyCorrectionEvidenceResponse(value: unknown, request: CorrectionEvidenceRequest, now: string): CorrectionEvidenceResponse {
  const validated = requestValue(request, invalidResponse);
  const current = timestamp(now, invalidResponse), checked = timestamp(validated.asOf, invalidResponse);
  if (checked < current - 30000 || checked > current + 2000) invalidResponse();
  const response = responseValue(value, validated);
  if (timestamp(response.verifiedAt, invalidResponse) > current + 2000) invalidResponse();
  return response;
}
