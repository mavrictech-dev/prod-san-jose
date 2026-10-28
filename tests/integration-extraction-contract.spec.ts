import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  IntegrationContractVersion, IntegrationDocumentTypes, IntegrationLimits, IntegrationPatterns, IntegrationScopes,
  assertIntegrationCursorContext, integrationArtifactAllowed, integrationGrantAllows, parseIntegrationDocumentFilters,
  parseIntegrationFiscalKey, parseIntegrationExportRequest, validIntegrationGrant,
  type IntegrationArtifactBindingV1, type IntegrationCursorContextV1, type IntegrationGrantV1, type IntegrationResourceV1,
} from '../packages/contracts/src/integration-extraction';
import { integrationOpenApiV1 } from '../packages/contracts/src/integration-openapi';

const api: any = integrationOpenApiV1();
const examples = JSON.parse(readFileSync(new URL('../api-contracts/integration/examples.v1.json', import.meta.url), 'utf8'));
const id = (prefix: number) => `${prefix}0000000-0000-4000-8000-000000000001`;
const rucA = '00000000101', rucB = '00000000202';
const query = { issuerRuc: rucA, from: '2026-10-01', to: '2026-10-09' };
const resource: IntegrationResourceV1 = { issuerRuc: rucA, environment: 'BETA', dataset: 'ISSUED_BUSINESS', type: '01', branchId: id(2), pointId: id(3), seriesCounterId: id(4) };
const grants: IntegrationGrantV1[] = [{ issuerRuc: rucA, environment: 'BETA', documentTypes: ['01', '03'], branches: { kind: 'IDS', ids: [id(2)] }, points: { kind: 'IDS', ids: [id(3)] }, series: { kind: 'IDS', ids: [id(4)] } }];
const scopes = ['integration:documents:read', 'integration:artifacts:read'] as const;
const binding = (): IntegrationArtifactBindingV1 => ({ issuerRuc: rucA, dataset: 'ISSUED_BUSINESS', environment: 'BETA', kind: 'CDR_XML', owner: { kind: 'BATCH', membersComplete: true, expectedMembers: 2, members: [{ ...resource, documentId: id(1) }, { ...resource, type: '03', documentId: id(5) }] } });

function resolveRef(reference: string): any {
  if (!reference.startsWith('#/')) throw new Error('Only local references allowed');
  return reference.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], api);
}
/** Test-only schema subset checker. NOT a general OpenAPI/JSON Schema validator or a security guard. */
function schemaMatches(schema: any, value: any): boolean {
  if (schema.$ref) return schemaMatches(resolveRef(schema.$ref), value);
  if (schema.anyOf && !schema.anyOf.some((s: any) => schemaMatches(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((s: any) => schemaMatches(s, value)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every((s: any) => schemaMatches(s, value))) return false;
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null' && value !== null) return false;
  if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.minLength !== undefined && value.length < schema.minLength)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === 'date' && (!/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return false;
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) return false;
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((schema.required ?? []).some((key: string) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    if (!Object.entries(schema.properties ?? {}).every(([key, prop]) => !Object.hasOwn(value, key) || schemaMatches(prop, value[key]))) return false;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || (schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every(v => schemaMatches(schema.items, v))) return false;
  }
  return true;
}
function walk(value: any, visit: (value: any) => void) {
  if (!value || typeof value !== 'object') return;
  visit(value); for (const child of Object.values(value)) walk(child, visit);
}
function exampleDocument(type: typeof IntegrationDocumentTypes[number]): any {
  const doc = structuredClone(examples.invoice);
  doc.type = type;
  if (type === '07' || type === '08') doc.detail.references = [{ documentId: id(8), type: '01', fullNumber: 'FQ01-00000002', kind: 'BILLING_REFERENCE', reasonCode: '01', reason: 'MOTIVO FICTICIO' }];
  if (type === '09' || type === '31') {
    doc.currency = null; doc.customer = null; doc.payableAmount = null; doc.series = type === '09' ? 'TQ01' : 'VQ01'; doc.fullNumber = doc.series + '-' + doc.number;
    const party = doc.detail.issuer;
    doc.detail = { kind: 'GUIDE', issuer: party, sender: party, recipient: party, carrier: null, items: doc.detail.items, reasonCode: '04', reason: 'TRASLADO FICTICIO', transferDate: '2026-10-09', origin: party, destination: party, grossWeight: '1.500000', weightUnit: 'KGM', packageCount: '1', modeCode: '02', vehicles: [{ plate: 'QA0001', authorization: null }], drivers: [{ identityType: '1', identityNumber: '00000001', firstNames: 'FICTICIO', lastNames: 'QA', license: null }], references: [], observations: null };
  }
  return doc;
}

describe('Phase 2 extraction query contract', () => {
  it('requires one RUC and inclusive dates; defaults to issued business Beta and all types', () => {
    expect(parseIntegrationDocumentFilters(query)).toEqual({ ...query, environment: 'BETA', dataset: 'ISSUED_BUSINESS', types: [...IntegrationDocumentTypes], limit: 100, cursor: null, branchId: null, pointId: null, series: null, currency: null, fiscalStatus: null });
  });
  it('normalizes type order without changing exact identity', () => {
    expect(parseIntegrationDocumentFilters({ ...query, types: '08,01,03', limit: '500', branchId: id(2), pointId: id(3), series: 'FQ01', currency: 'USD', fiscalStatus: 'ACCEPTED', cursor: 'a'.repeat(16) })).toMatchObject({ types: ['01', '03', '08'], limit: 500, issuerRuc: rucA });
  });
  it.each([
    {}, { ...query, issuerRuc: 101 }, { ...query, issuerRuc: rucA + ',' + rucB },
    { ...query, from: '2026-02-30' }, { ...query, to: '2026-02-29' }, { ...query, from: '2026-10-10' },
    { ...query, from: '2024-01-01', to: '2025-01-01' }, { ...query, from: '1999-01-01' },
    { ...query, environment: 'PRODUCTION' }, { ...query, environment: 'beta' }, { ...query, dataset: 'SYNTHETIC' }, { ...query, dataset: 'RECEIVED' },
    { ...query, types: '01,01' }, { ...query, types: '01,03,' }, { ...query, types: ['01'] }, { ...query, types: '99' },
    { ...query, limit: '0' }, { ...query, limit: '501' }, { ...query, limit: '1e2' }, { ...query, limit: '01' },
    { ...query, pointId: 'CAJA01' }, { ...query, branchId: '*' }, { ...query, series: 'fq01' }, { ...query, currency: 'EUR' },
    { ...query, fiscalStatus: 'SIMULATED_ACCEPTED' }, { ...query, cursor: '../secret' }, { ...query, cursor: 'a'.repeat(4097) },
    { ...query, page: '1' }, { ...query, access_token: 'not-a-token' }, { ...query, issuerRuc: ['00000000101'] },
  ])('rejects invalid/ambiguous query %#', value => expect(() => parseIntegrationDocumentFilters(value)).toThrow('INVALID_QUERY'));
  it('accepts leap day and the exact 366-day ceiling', () => {
    expect(parseIntegrationDocumentFilters({ ...query, from: '2024-01-01', to: '2024-12-31' }).from).toBe('2024-01-01');
    expect(parseIntegrationDocumentFilters({ ...query, from: '2024-02-29', to: '2024-02-29' }).to).toBe('2024-02-29');
  });
  it('rejects inherited required filters, not just unknown own keys', () => {
    expect(() => parseIntegrationDocumentFilters(Object.create(query))).toThrow('INVALID_QUERY');
    expect(() => parseIntegrationDocumentFilters(Object.assign(Object.create({ cursor: 'a'.repeat(16) }), query))).toThrow('INVALID_QUERY');
  });
  it('looks up by full fiscal tuple and preserves leading zeros/BigInt precision', () => {
    const key = { issuerRuc: rucA, type: '01', series: 'FQ01', number: '0009007199254740993' };
    expect(parseIntegrationFiscalKey(key)).toEqual({ ...key, environment: 'BETA' });
  });
  it.each([
    { issuerRuc: rucA, series: 'FQ01', number: '1' }, { issuerRuc: rucA, type: '31', number: '1' },
    { issuerRuc: rucA, type: '01', series: 'FQ01', number: 1 }, { issuerRuc: rucA, type: '01', series: 'FQ01', number: '1e2' },
    { issuerRuc: rucA, type: '01', series: 'FQ01', number: '1', environment: 'PRODUCTION' },
    { issuerRuc: rucA, type: ['01'], series: 'FQ01', number: '1' },
  ])('rejects ambiguous fiscal lookup %#', q => expect(() => parseIntegrationFiscalKey(q)).toThrow('INVALID_QUERY'));
});

describe('Export request contract', () => {
  it('validates the example and normalizes Beta/business/type order only', () => {
    expect(parseIntegrationExportRequest(examples.exportRequest)).toEqual(examples.exportRequest);
    const parsed = parseIntegrationExportRequest({ ...examples.exportRequest, filters: query, artifactKinds: [] });
    expect(parsed.filters).toMatchObject({ ...query, environment: 'BETA', dataset: 'ISSUED_BUSINESS', types: [...IntegrationDocumentTypes] });
    expect(parsed.artifactKinds).toEqual([]);
  });
  it.each([
    { artifactKinds: ['SIMULATED_CDR'] }, { artifactKinds: ['CDR_XML', 'CDR_XML'] }, { artifactKinds: 'CDR_XML' },
    { missingArtifacts: 'IGNORE' }, { dataFormat: 'CSV' }, { callbackUrl: 'https://example.invalid' },
    { filters: { ...query, environment: 'PRODUCTION' } }, { filters: { ...query, dataset: 'SYNTHETIC' } },
    { filters: { ...query, types: '01,03' } }, { filters: { ...query, types: [] } },
    { filters: { ...query, limit: '100' } }, { filters: { ...query, branchId: null } },
    { filters: { ...query, types: ['01', '01'] } }, { filters: { ...query, from: '2026-02-30' } },
  ])('rejects export widening or silent omission %#', patch => expect(() => parseIntegrationExportRequest({ ...examples.exportRequest, ...patch })).toThrow('INVALID_REQUEST'));
  it('defines a portable manifest path whitelist, no storage path or traversal', () => {
    const paths = api.components.schemas.ExportManifest.properties.files.items.properties.path;
    for (const path of ['documents.jsonl', 'artifacts/' + id(1) + '.xml', 'artifacts/' + id(2) + '.zip']) expect(schemaMatches(paths, path)).toBe(true);
    for (const path of ['../manifest.json', 'C:/certs/secret.p12', '/data/artifacts/file.xml', 'artifacts/../../file.xml', 'artifacts/' + '-'.repeat(36) + '.xml']) expect(schemaMatches(paths, path)).toBe(false);
    expect(api.components.schemas.ExportManifest.properties).not.toHaveProperty('storageKey');
  });
});

describe('Phase 2 pure policy, not an authenticator', () => {
  it('allows only a complete authorized tuple', () => expect(integrationGrantAllows(grants, resource)).toBe(true));
  it.each([{ issuerRuc: rucB }, { branchId: id(8) }, { pointId: id(8) }, { seriesCounterId: id(8) }, { type: '09' }, { environment: 'PRODUCTION' }, { dataset: 'SYNTHETIC' }, { branchId: null }, { pointId: null }, { seriesCounterId: null }])('denies scope mismatch %#', patch => expect(integrationGrantAllows(grants, { ...resource, ...patch } as any)).toBe(false));
  it('does not create a Cartesian product between different grants', () => {
    const other: IntegrationGrantV1 = { ...grants[0], issuerRuc: rucB, branches: { kind: 'IDS', ids: [id(6)] }, points: { kind: 'IDS', ids: [id(7)] }, series: { kind: 'IDS', ids: [id(8)] } };
    expect(integrationGrantAllows([...grants, other], { ...resource, issuerRuc: rucB })).toBe(false);
  });
  it('requires explicit ALL; empty IDS and malformed rules fail closed', () => {
    expect(validIntegrationGrant({ ...grants[0], branches: { kind: 'IDS', ids: [] } })).toBe(true);
    expect(integrationGrantAllows([{ ...grants[0], branches: { kind: 'IDS', ids: [] } }], resource)).toBe(false);
    for (const branches of [undefined, null, { kind: 'ALL', ids: [] }, { kind: 'IDS', ids: ['*'] }, { kind: 'IDS', ids: [id(2), id(2)] }]) expect(validIntegrationGrant({ ...grants[0], branches })).toBe(false);
    expect(integrationGrantAllows([], resource)).toBe(false);
    expect(integrationGrantAllows([{ ...grants[0], branches: { kind: 'ALL' }, points: { kind: 'ALL' }, series: { kind: 'ALL' } }], { ...resource, branchId: null, pointId: null, seriesCounterId: null })).toBe(true);
  });
  it('authorizes a complete batch only if every distinct member belongs to the same RUC and scope', () => expect(integrationArtifactAllowed(scopes, grants, binding())).toBe(true));
  it.each(['membersComplete', 'count', 'duplicate', 'different-ruc', 'different-scope', 'production', 'unknown-kind', 'empty'] as const)('denies unsafe batch %#', kind => {
    const b: any = binding();
    if (kind === 'membersComplete') b.owner.membersComplete = false;
    if (kind === 'count') b.owner.expectedMembers = 3;
    if (kind === 'duplicate') b.owner.members[1].documentId = id(1);
    if (kind === 'different-ruc') b.owner.members[1].issuerRuc = rucB;
    if (kind === 'different-scope') b.owner.members[1].branchId = id(8);
    if (kind === 'production') b.owner.members[1].environment = 'PRODUCTION';
    if (kind === 'unknown-kind') b.kind = 'SIMULATED_CDR';
    if (kind === 'empty') { b.owner.members = []; b.owner.expectedMembers = 0; }
    expect(integrationArtifactAllowed(scopes, grants, b)).toBe(false);
  });
  it('requires both document and artifact scopes; human permissions never substitute them', () => {
    for (const candidate of [[], ['integration:documents:read'], ['integration:artifacts:read'], ['document.view', ...scopes]]) expect(integrationArtifactAllowed(candidate as any, grants, binding())).toBe(false);
  });
  it('rechecks individual owner identity too', () => {
    const b: IntegrationArtifactBindingV1 = { ...binding(), kind: 'SIGNED_XML', owner: { kind: 'DOCUMENT', resource } };
    expect(integrationArtifactAllowed(scopes, grants, b)).toBe(true);
    expect(integrationArtifactAllowed(scopes, grants, { ...b, issuerRuc: rucB })).toBe(false);
    expect(integrationArtifactAllowed(scopes, [], b)).toBe(false);
  });
});

describe('Context of an already authenticated cursor', () => {
  const context: IntegrationCursorContextV1 = { version: 'factuez.integration.cursor.v1', clientId: id(1), grantRevision: 4, scopeHash: 'a'.repeat(64), filterHash: 'b'.repeat(64), environment: 'BETA', dataset: 'ISSUED_BUSINESS', snapshotId: id(2), expiresAt: 2000 };
  const expected = () => { const { expiresAt: _unused, ...rest } = context; return rest; };
  it('retains the exact client/scope/filter/cut context', () => expect(() => assertIntegrationCursorContext(context, expected(), 1900)).not.toThrow());
  it.each([{ clientId: id(3) }, { grantRevision: 5 }, { scopeHash: 'c'.repeat(64) }, { filterHash: 'd'.repeat(64) }, { snapshotId: id(4) }, { environment: 'PRODUCTION' }, { dataset: 'RECEIVED' }, { grantRevision: NaN }])('rejects changed cursor context %#', patch => expect(() => assertIntegrationCursorContext({ ...context, ...patch } as any, expected(), 1900)).toThrow('CURSOR_CONTEXT_CHANGED'));
  it('expires at the boundary, including every subsequent page', () => {
    expect(() => assertIntegrationCursorContext(context, expected(), 2000)).toThrow('CURSOR_EXPIRED');
    expect(() => assertIntegrationCursorContext(context, expected(), 2001)).toThrow('CURSOR_EXPIRED');
  });
});

describe('Versioned OpenAPI design and fictitious examples', () => {
  it('has a synchronized serializable snapshot, 17 planned operations and no operational URL', () => {
    expect(JSON.parse(readFileSync(new URL('../api-contracts/integration/private-api.openapi.v1.json', import.meta.url), 'utf8'))).toEqual(api);
    expect(Object.keys(api.paths)).toHaveLength(17);
    expect(api).toMatchObject({ openapi: '3.1.1', 'x-delivery-state': 'CONTRACT_ONLY', 'x-environment': 'BETA', 'x-contract-version': IntegrationContractVersion });
    expect(api.servers[0].url).toBe('https://factuez.invalid');
  });
  it('resolves every local reference and requires unique protected operations', () => {
    walk(api, node => { if (node.$ref) expect(resolveRef(node.$ref), node.$ref).toBeDefined(); });
    const ids: string[] = [];
    for (const [path, methods] of Object.entries(api.paths) as [string, any][]) for (const [method, operation] of Object.entries(methods) as [string, any][]) {
      expect(['get', 'post']).toContain(method); ids.push(operation.operationId);
      expect(operation['x-implemented']).toBe(false);
      expect(operation['x-implementation-phase']).toBeGreaterThanOrEqual(3);
      expect(operation.security).toHaveLength(1);
      for (const [scheme, scopes] of Object.entries(operation.security[0]) as [string, string[]][]) {
        expect(api.components.securitySchemes[scheme]).toBeDefined();
        for (const scope of scopes) expect(IntegrationScopes).toContain(scope);
      }
      const params = operation.parameters ?? [];
      expect(new Set(params.map((p: any) => p.in + ':' + p.name)).size).toBe(params.length);
      for (const match of path.matchAll(/\{([^}]+)\}/g)) expect(params.some((p: any) => p.in === 'path' && p.name === match[1] && p.required === true)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('offers only reads, token grant and export jobs; no issue/cancel/email/configuration writes', () => {
    expect(Object.entries(api.paths).filter(([, ops]) => (ops as any).post).map(([path]) => path)).toEqual(['/integration/oauth/token', '/integration/v1/exports']);
    for (const path of Object.keys(api.paths)) expect(path).not.toMatch(/sunat-settings|credentials|certificates|issue$|void$|send$|smtp/);
    expect(api.components.securitySchemes.IntegrationOAuth.flows).toHaveProperty('clientCredentials');
    expect(api.components.schemas.Token.properties).not.toHaveProperty('refresh_token');
  });
  it('describes limits and query enums from the same source of truth', () => {
    expect(api.components.schemas.Capabilities.properties.limits.properties.maxPageSize.const).toBe(IntegrationLimits.maxPageSize);
    expect(api.components.schemas.DocumentRow.properties.type.enum).toEqual([...IntegrationDocumentTypes]);
    for (const [name, value] of Object.entries(query)) {
      const param = api.paths['/integration/v1/documents'].get.parameters.find((p: any) => p.name === name);
      expect(param.required).toBe(true); expect(schemaMatches(param.schema, value)).toBe(true);
    }
    const types = api.paths['/integration/v1/documents'].get.parameters.find((p: any) => p.name === 'types');
    expect(types).toMatchObject({ style: 'form', explode: false });
  });
  it('requires dynamic artifact scope for exports and validates idempotency syntax', () => {
    expect(api.paths['/integration/v1/exports'].post['x-conditional-scopes']).toEqual({ nonEmptyArtifactKinds: ['integration:artifacts:read'] });
    expect(api.paths['/integration/v1/exports/{exportId}/content'].get['x-conditional-scopes']).toEqual({ jobContainsArtifacts: ['integration:artifacts:read'] });
    const parameter = api.paths['/integration/v1/exports'].post.parameters[0];
    expect(parameter.required).toBe(true); expect(schemaMatches(parameter.schema, 'idempotency_key01')).toBe(true);
    expect(schemaMatches(parameter.schema, 'bad\r\nkey')).toBe(false);
  });
  it('keeps bytes separate from metadata and includes integrity/no-store headers', () => {
    const content = api.paths['/integration/v1/artifacts/{artifactId}/content'].get.responses['200'];
    expect(Object.keys(content.content)).toEqual(['application/xml', 'application/zip', 'application/pdf']);
    expect(content.headers['Cache-Control'].schema.const).toBe('private, no-store');
    expect(content.headers['X-Content-SHA256'].schema.pattern).toBe(IntegrationPatterns.sha256);
    expect(api.components.schemas.Artifact.properties).not.toHaveProperty('storageKey');
    expect(api.components.schemas.Artifact.properties).not.toHaveProperty('contentBase64');
  });
  it.each(IntegrationDocumentTypes)('models complete fictitious detail for type %s without a fiscal claim', type => {
    const document = exampleDocument(type);
    expect(schemaMatches(api.components.schemas.DocumentDetail, document)).toBe(true);
    expect(document.state.fiscal).toBe('NOT_CHECKED');
    expect(document.state.verifiedAt).toBeNull();
    expect(document.detail.items[0].quantity).toBe('2.000000');
  });
  it('rejects monetary floats, type/detail mismatch, secret additions and missing note reference', () => {
    const mutations = [
      (d: any) => { d.payableAmount = 118; },
      (d: any) => { d.detail.items[0].unitValue = 50; },
      (d: any) => { d.number = 9007199254740993; },
      (d: any) => { d.type = '31'; },
      (d: any) => { d.storageKey = '/not-a-real-path'; },
      (d: any) => { d.environment = 'PRODUCTION'; },
      (d: any) => { d.type = '07'; },
    ];
    for (const mutation of mutations) { const document = exampleDocument('01'); mutation(document); expect(schemaMatches(api.components.schemas.DocumentDetail, document)).toBe(false); }
  });
  it('validates example metadata, export request and redacted error; null is not fabricated zero', () => {
    expect(examples).toMatchObject({ fixtureOnly: true, runtimeRecordsCreated: false });
    expect(schemaMatches(api.components.schemas.Artifact, examples.batchCdr)).toBe(true);
    expect(schemaMatches(api.components.schemas.ExportRequest, examples.exportRequest)).toBe(true);
    expect(schemaMatches(api.components.schemas.Error, examples.unavailableError)).toBe(true);
    expect(examples.invoice.detail.totals.exemptAmount).toBeNull();
    expect(examples.batchCdr.verification.trust).toBe('UNVERIFIED');
  });
  it('keeps contract code dependency-free with no IO/auth service activation', () => {
    for (const path of ['../packages/contracts/src/integration-extraction.ts', '../packages/contracts/src/integration-openapi.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/process\.env|fetch\(|PrismaClient|createServer|listen\(|node:fs|node:crypto|new Queue|BullMQ/);
    }
    const manifest = JSON.parse(readFileSync(new URL('../packages/contracts/package.json', import.meta.url), 'utf8'));
    expect(manifest.exports['./integration']).toBeDefined(); expect(manifest.exports['./integration-openapi']).toBeDefined();
    expect(readFileSync(new URL('../packages/contracts/src/index.ts', import.meta.url), 'utf8')).not.toContain('integration-openapi');
  });
});
