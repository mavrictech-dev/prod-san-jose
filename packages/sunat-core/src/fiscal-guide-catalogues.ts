import { boundedSupplementJson } from './fiscal-supplement-command';
import { fiscalSnapshotSha256 } from './fiscal-note';

/** Local, versioned reference only; neither provenance nor hashes establish official validity. */
export type GuideReferenceCatalogue = {
  schemaVersion: 'factuez.guide-reference-catalogue.v1';
  version: string;
  sourceUrl: string;
  sourceSha256: string;
  units: string[];
  weightUnits: string[];
  ubigeos: string[];
  referenceStatus: 'LOCAL_REFERENCE_NOT_OFFICIAL';
  sha256: string;
};
type ErrorCode = 'INVALID_GUIDE_REFERENCE_CATALOGUE' | 'GUIDE_REFERENCE_CODE_NOT_ENABLED';
export class GuideCatalogueError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'GuideCatalogueError'; }
}
const INVALID = 'INVALID_GUIDE_REFERENCE_CATALOGUE';
const DISABLED = 'GUIDE_REFERENCE_CODE_NOT_ENABLED';
const HASH = /^[a-f0-9]{64}$/;
const UNIT = /^[A-Z0-9]{2,3}$/;
const UBIGEO = /^\d{6}$/;
const KEYS = ['schemaVersion', 'version', 'sourceUrl', 'sourceSha256', 'units', 'weightUnits', 'ubigeos', 'referenceStatus', 'sha256'];
function fail(code: ErrorCode): never { throw new GuideCatalogueError(code); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function matches(value: unknown, pattern: RegExp): value is string {
  // JS $ also matches before a final newline; require the entire string.
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function canonicalList(value: unknown, maximum: number, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= maximum &&
    value.every((entry, i) => matches(entry, pattern) && (i === 0 || value[i - 1] < entry));
}
function sourceUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 500 ||
      !/^https:\/\/(?:www\.sunat\.gob\.pe|cpe\.sunat\.gob\.pe)(?::443)?(?:\/|$)/i.test(value) ||
      /[\s\\?#\x00-\x1f\x7f-\x9f]/u.test(value)) return false;
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.sunat.gob.pe', 'cpe.sunat.gob.pe'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.port) return false;
  let decoded = decodeURIComponent(value);
  // Also reject controls concealed behind multiple levels of percent escaping.
  while (true) {
    if (/[\x00-\x1f\x7f-\x9f]/u.test(decoded)) return false;
    if (!/%[a-f0-9]{2}/i.test(decoded)) return true;
    const next = decodeURIComponent(decoded);
    if (next === decoded) return true;
    decoded = next;
  }
}
export function validateGuideReferenceCatalogue(value: unknown): GuideReferenceCatalogue {
  try {
    const v = boundedSupplementJson(value);
    if (!record(v) || Object.keys(v).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(v, key)) ||
        v.schemaVersion !== 'factuez.guide-reference-catalogue.v1' || v.referenceStatus !== 'LOCAL_REFERENCE_NOT_OFFICIAL' ||
        !matches(v.version, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/) || !sourceUrl(v.sourceUrl) ||
        !matches(v.sourceSha256, HASH) || !matches(v.sha256, HASH) ||
        !canonicalList(v.units, 200, UNIT) || !canonicalList(v.weightUnits, 2, /^(KGM|TNE)$/) ||
        !canonicalList(v.ubigeos, 500, UBIGEO)) fail(INVALID);
    const { sha256, ...unsigned } = v;
    if (fiscalSnapshotSha256(unsigned) !== sha256) fail(INVALID);
    return v as GuideReferenceCatalogue;
  } catch { return fail(INVALID); }
}
/** Body is fully validated upstream; unrelated JSON fields are intentionally ignored here. */
export function assertGuideReferenceCodes(catalogue: unknown, body: unknown): GuideReferenceCatalogue {
  const validated = validateGuideReferenceCatalogue(catalogue);
  try {
    const b = boundedSupplementJson(body);
    if (!record(b) || !record(b.origin) || !record(b.destination) ||
        !matches(b.origin.ubigeo, UBIGEO) || !validated.ubigeos.includes(b.origin.ubigeo) ||
        !matches(b.destination.ubigeo, UBIGEO) || !validated.ubigeos.includes(b.destination.ubigeo) ||
        !matches(b.weightUnit, /^(KGM|TNE)$/) || !validated.weightUnits.includes(b.weightUnit) ||
        !Array.isArray(b.items) || b.items.length < 1 || b.items.length > 100 ||
        b.items.some(item => !record(item) || !matches(item.unitCode, UNIT) || !validated.units.includes(item.unitCode))) fail(DISABLED);
    return validated;
  } catch { return fail(DISABLED); }
}
