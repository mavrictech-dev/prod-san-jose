import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { nativeRuntimeOpenApiPaths, nativeRuntimeOpenApiSecuritySchemes } from '../services/sunat-service/src/runtime-native-openapi';
import { administrationOpenApiPaths } from '../services/sunat-service/src/runtime-administration-openapi';
import { fiscalRuntimeOpenApi } from '../services/sunat-service/src/runtime-openapi.controller';
import { PermissionCodes, RoleCodes } from '../packages/contracts/src/authorization';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';

const controllers = [
  'identity-service/src/auth.controller.ts', 'identity-service/src/browser-session.controller.ts', 'identity-service/src/users.controller.ts',
  'billing-service/src/stations.controller.ts', 'billing-service/src/products.controller.ts', 'billing-service/src/documents.controller.ts',
  'billing-service/src/print-settings.controller.ts', 'received-documents-service/src/received.controller.ts',
];
const read = (file: string) => readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
const parse = (file: string) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function decorators(node: ts.Node) {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []).flatMap(d => ts.isCallExpression(d.expression) ? [d.expression] : []) : [];
}
const decorator = (node: ts.Node, name: string) => decorators(node).find(d => d.expression.getText() === name);
const arg = (call?: ts.CallExpression) => call?.arguments[0] && ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : '';
function routes() {
  return controllers.flatMap(file => {
    const source = parse('services/' + file);
    return source.statements.filter(ts.isClassDeclaration).flatMap(controller => {
      const base = arg(decorator(controller, 'Controller'));
      return controller.members.filter(ts.isMethodDeclaration).flatMap(method => {
        const verb = decorators(method).find(d => ['Get', 'Post', 'Patch', 'Delete', 'Put'].includes(d.expression.getText()));
        if (!verb) return [];
        const status = decorator(method, 'HttpCode')?.arguments[0];
        const params = method.parameters.flatMap(parameter => decorators(parameter)).filter(d => ['Query', 'Headers'].includes(d.expression.getText())).map(d => ({
          name: d.expression.getText() === 'Headers' ? arg(d).toLowerCase() : arg(d), in: d.expression.getText() === 'Query' ? 'query' : 'header',
        })).filter(p => p.name && p.name !== 'authorization');
        return [{ file, path: ('/' + base + '/' + arg(verb)).replace(/\/$/, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
          method: verb.expression.getText().toLowerCase(), success: status ? Number(status.getText()) : verb.expression.getText() === 'Post' ? 201 : 200, params }];
      });
    });
  });
}
type JsonSchema = { [key: string]: any };
const native = nativeRuntimeOpenApiPaths();
const paths = native as Record<string, Record<string, any>>;
const body = (path: string, method = 'post'): JsonSchema => paths[path][method].requestBody.content['application/json'].schema;
const response = (path: string, method = 'get', status = 200): JsonSchema => paths[path][method].responses[status].content['application/json'].schema;
function interfaceKeys(file: string, name: string) {
  const node = parse(file).statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === name) as ts.InterfaceDeclaration;
  expect(node, name).toBeDefined();
  return node.members.map(member => member.name!.getText()).sort();
}
function walk(value: unknown, visit: (value: Record<string, unknown>) => void) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) visit(value as Record<string, unknown>);
  Object.values(value).forEach(child => walk(child, visit));
}

describe('Native runtime OpenAPI follows published controllers', () => {
  it('covers every route of the eight selected real controllers and invents none', () => {
    const real = routes();
    const documented = Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map(method => method + ' ' + path));
    expect(documented.sort()).toEqual(real.map(route => route.method + ' ' + route.path).sort());
    expect(new Set(documented).size).toBe(documented.length);
    console.info('Native runtime: ' + Object.keys(paths).length + ' paths, ' + documented.length + ' operations');
  });
  it('uses the actual Nest success statuses and every explicit header/query decorator', () => {
    for (const route of routes()) {
      const operation = paths[route.path][route.method];
      expect(Object.keys(operation.responses).filter(code => Number(code) < 300), route.method + ' ' + route.path).toEqual([String(route.success)]);
      for (const parameter of route.params) expect(operation.parameters).toEqual(expect.arrayContaining([expect.objectContaining(parameter.in === 'header'
        ? { in: 'header', name: expect.stringMatching(new RegExp('^' + parameter.name + '$', 'i')) } : parameter)]));
      expect(operation.responses).toHaveProperty('401');
      expect(operation.responses).toHaveProperty('503');
    }
  });
  it('preserves administration and fiscal paths, merges without collisions and excludes admission', () => {
    const specification = fiscalRuntimeOpenApi();
    const all = specification.paths as Record<string, Record<string, any>>;
    for (const [path, methods] of Object.entries(administrationOpenApiPaths())) {
      expect(paths[path], path).toBeUndefined();
      expect(all[path], path).toEqual(methods);
    }
    for (const [path, methods] of Object.entries(paths)) expect(all[path], path).toEqual(methods);
    expect(all).toHaveProperty('/api/v1/setup/sunat/{companyId}/{environment}');
    expect(all).toHaveProperty('/api/v1/fiscal-artifacts/{documentId}/original/{kind}');
    expect(all).not.toHaveProperty('/api/v1/setup/sunat/{companyId}/PRODUCTION/admission');
    const operationIds = Object.values(all).flatMap(methods => Object.values(methods).map(op => op.operationId));
    expect(new Set(operationIds).size).toBe(operationIds.length);
    const normalized = Object.keys(all).map(path => path.replace(/\{[^}]+\}/g, '{}'));
    expect(new Set(normalized).size).toBe(normalized.length);
    console.info('Merged runtime: ' + Object.keys(all).length + ' paths, ' + operationIds.length + ' operations');
  });
  it('declares credential login and cookie session independently of human Bearer APIs', () => {
    expect(paths['/api/v1/auth/login'].post.security).toEqual([]);
    expect(paths['/api/v1/auth/browser-session/login'].post.security).toEqual([]);
    expect(paths['/api/v1/auth/me'].get.security).toEqual([{ HumanSessionBearer: [] }]);
    expect(paths['/api/v1/auth/browser-session'].get.security).toEqual([{ NativeBrowserSessionCookie: [] }]);
    expect(paths['/api/v1/auth/browser-session/logout'].post.security).toEqual([{}, { NativeBrowserSessionCookie: [] }]);
    for (const suffix of ['login', 'activity', 'logout']) expect(paths['/api/v1/auth/browser-session/' + suffix].post.parameters).toContainEqual(expect.objectContaining({ name: 'Origin', in: 'header', required: true }));
    expect(nativeRuntimeOpenApiSecuritySchemes().NativeBrowserSessionCookie).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'factuez_session' });
    expect(fiscalRuntimeOpenApi().components.securitySchemes).toHaveProperty('NativeBrowserSessionCookie');
    expect(response('/api/v1/auth/browser-session').properties.idleTimeoutSeconds.const).toBe(1800);
    expect(paths['/api/v1/auth/browser-session'].get.description).toContain('sin modificar lastActivityAt');
    expect(body('/api/v1/auth/login').properties.password).toMatchObject({ writeOnly: true, maxLength: 256 });
  });
  it('matches issuance DTO fields, numeric strings, profile and idempotency exactly', () => {
    const schema = body('/api/v1/documents');
    expect(Object.keys(schema.properties).sort()).toEqual(interfaceKeys('services/billing-service/src/application/issue-document.service.ts', 'IssueDocumentInput'));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.documentType.enum).toEqual(['INVOICE', 'SALES_RECEIPT']);
    expect(schema.properties.lines).toMatchObject({ minItems: 1, maxItems: 100 });
    const line = schema.properties.lines.items;
    expect(line.properties.quantity.type).toBe('string');
    expect(line.properties.unitPriceWithTax.type).toBe('string');
    expect(line.properties.taxAffectationCode.const).toBe('10');
    expect(line.properties.igvRate.const).toBe('18');
    expect(Object.keys(line.properties).sort()).toEqual(['productId', 'productCode', 'description', 'unitCode', 'quantity', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate'].sort());
    const key = paths['/api/v1/documents'].post.parameters.find((p: any) => p.name === 'Idempotency-Key');
    expect(key).toMatchObject({ in: 'header', required: true, schema: { pattern: '^[a-zA-Z0-9_-]{1,100}$' } });
    expect(new RegExp(key.schema.pattern).test('sale_123-ABC')).toBe(true);
    expect(new RegExp(key.schema.pattern).test('bad key')).toBe(false);
    expect(paths['/api/v1/documents'].post.responses).toHaveProperty('409');
    expect(paths['/api/v1/documents'].post.description).toContain('INVOICE=01');
    expect(paths['/api/v1/documents'].post.description).toContain('SALES_RECEIPT=03');
    expect(paths['/api/v1/documents/{documentId}']).toHaveProperty('get');
    expect(Object.keys(paths['/api/v1/documents/{documentId}'])).toEqual(['get']);
    const detail = response('/api/v1/documents/{documentId}');
    expect(detail.properties.immutableSnapshot.properties).toHaveProperty('totals');
    expect(schema.properties.paymentTerms.oneOf[1].properties.installments).toMatchObject({ minItems: 1, maxItems: 999 });
  });
  it('documents preview as a calculation and page/query limits from the query service', () => {
    const result = calculateDocumentTotals([{ description: 'Sintético', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' }]);
    expect(result.totals).toEqual({ taxableAmount: '200.00', igvAmount: '36.00', payableAmount: '236.00' });
    expect(Object.keys(response('/api/v1/documents/preview', 'post', 201).properties).sort()).toEqual(Object.keys(result).sort());
    const list = paths['/api/v1/documents'].get;
    expect(list.parameters.find((p: any) => p.name === 'page').schema).toMatchObject({ minimum: 1, maximum: 100000, default: 1 });
    expect(list.parameters.find((p: any) => p.name === 'q').schema.maxLength).toBe(100);
    expect(response('/api/v1/documents').properties.pageSize.const).toBe(20);
  });
  it('keeps master field whitelists, revisions, SUNAT series and immutable counters', () => {
    expect(Object.keys(body('/api/v1/stations/issuers').properties).sort()).toEqual(interfaceKeys('packages/contracts/src/station-admin.ts', 'StationIssuerDraft'));
    expect(Object.keys(body('/api/v1/stations').properties).sort()).toEqual(interfaceKeys('packages/contracts/src/station-admin.ts', 'StationBranchDraft'));
    expect(Object.keys(body('/api/v1/stations/{id}/points').properties).sort()).toEqual(interfaceKeys('packages/contracts/src/station-admin.ts', 'StationPointDraft'));
    expect(Object.keys(body('/api/v1/stations/points/{id}/series').properties).sort()).toEqual(interfaceKeys('packages/contracts/src/station-admin.ts', 'StationSeriesDraft'));
    expect(body('/api/v1/stations/points/{id}/series').properties.documentType.enum).toEqual(['INVOICE', 'SALES_RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE', 'DESPATCH_ADVICE']);
    for (const [path, methods] of Object.entries(paths).filter(([p]) => p.startsWith('/api/v1/stations/') && !p.includes('print-settings') && !p.includes('products'))) {
      for (const [method, op] of Object.entries(methods)) if (['patch', 'delete'].includes(method)) {
        expect(body(path, method).required).toContain('expectedRevision');
        expect(body(path, method).properties).not.toHaveProperty('nextNumber');
        expect(body(path, method).properties).not.toHaveProperty('ruc');
        expect(op.responses).toHaveProperty('409');
      }
    }
    expect(body('/api/v1/stations/{id}', 'patch').properties.establishmentCode.anyOf[0].pattern).toBe('^\\d{4}$');
    expect(body('/api/v1/stations/products/{id}', 'patch').required).toEqual(['expectedUpdatedAt']);
  });
  it('uses real user/role DTOs and protected operational extra permissions', () => {
    expect(Object.keys(body('/api/v1/users').properties).sort()).toEqual(interfaceKeys('services/identity-service/src/application/user-administration.service.ts', 'CreateUserInput'));
    expect(Object.keys(body('/api/v1/users/{id}/access', 'patch').properties).sort()).toEqual(interfaceKeys('services/identity-service/src/application/user-administration.service.ts', 'UpdateUserAccessInput'));
    expect(body('/api/v1/users').properties.roles.items.enum).toEqual(Object.values(RoleCodes));
    expect(body('/api/v1/users').properties.password).toMatchObject({ minLength: 12, maxLength: 256, writeOnly: true });
    expect(body('/api/v1/users').properties.series.items.format).toBe('uuid');
    expect(body('/api/v1/roles/{code}', 'patch').properties.permissions.items.enum).toEqual(Object.values(PermissionCodes));
    expect(body('/api/v1/roles/{code}', 'patch').required).toEqual(['permissions', 'expectedPermissions']);
    expect(body('/api/v1/users/{id}/permissions', 'patch').required).toEqual(['permissions', 'expectedAuthVersion']);
    expect(body('/api/v1/users/{id}/permissions', 'patch').properties.permissions.items.enum).not.toContain('sunat.configure');
  });
  it('documents print inheritance, bounded logos and SUNAT print types without promising fiscal issuance', () => {
    const save = body('/api/v1/stations/print-settings/{companyId}');
    expect(save.required).toEqual(['expectedRevision', 'settings']);
    expect(save.properties.settings.anyOf[1]).toEqual({ type: 'null' });
    expect(Object.keys(save.properties.settings.anyOf[0].properties).sort()).toEqual(interfaceKeys('packages/contracts/src/print-presentation.ts', 'PrintBrandingSettings'));
    expect(save.properties.logoUpload.properties.mediaType.enum).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(save.properties.logoUpload.properties.base64.maxLength).toBe(349528);
    const preview = body('/api/v1/stations/print-settings/{companyId}/preview');
    expect(preview.properties.documentTypeCode.enum).toEqual(['01', '03', '07', '08', '09', '31']);
    expect(preview.properties.format.enum).toEqual(['a4', 'ticket']);
    expect(paths['/api/v1/stations/print-settings/{companyId}/preview'].post.responses['201'].content).toHaveProperty('application/pdf');
  });
  it('documents reception import, filters, results and unverified original projections', () => {
    const base = '/api/v1/received-documents';
    expect(Object.keys(body(base).properties).sort()).toEqual(interfaceKeys('packages/contracts/src/received-documents.ts', 'ReceivedUploadCommand'));
    expect(body(base).properties.files).toMatchObject({ minItems: 1, maxItems: 10 });
    expect(body(base).properties.files.items.properties.contentBase64.maxLength).toBe(5592408);
    expect(response(base, 'post', 201).properties.results.items.properties.outcome.enum).toEqual(['IMPORTED', 'DUPLICATE', 'REJECTED']);
    expect(paths[base].post.parameters.some((p: any) => p.name === 'Idempotency-Key')).toBe(false);
    expect(paths[base].get.parameters.map((p: any) => p.name)).toEqual(['companyId', 'branchId', 'q', 'type', 'from', 'to', 'page', 'dataSource']);
    expect(response(base).properties.pageSize.const).toBe(25);
    expect(response(base + '/{id}').properties.projection.properties.signature.properties.officialTrust.const).toBe(false);
    expect(response(base + '/{id}').properties.sunatStatus.const).toBe('NOT_CHECKED');
    expect(body(base + '/{id}/assignment', 'patch').required).toEqual(['branchId', 'expectedBranchId']);
  });
  it('has complete path parameters, unique operation IDs, valid security refs and no private examples', () => {
    const securityNames = Object.keys(fiscalRuntimeOpenApi().components.securitySchemes);
    for (const [path, methods] of Object.entries(paths)) {
      expect(path).not.toMatch(/internal|admission|labs?|qa|owner|rpc/i);
      for (const operation of Object.values(methods)) {
        expect(operation.parameters.filter((p: any) => p.in === 'path').map((p: any) => p.name).sort())
          .toEqual([...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort());
        for (const security of operation.security) for (const key of Object.keys(security)) expect(securityNames).toContain(key);
      }
    }
    walk(native, value => {
      expect(value).not.toHaveProperty('example');
      expect(value).not.toHaveProperty('examples');
      expect(value).not.toHaveProperty('default', expect.stringMatching(/Bearer /));
      if (value.pattern) expect(() => new RegExp(String(value.pattern))).not.toThrow();
    });
    expect(JSON.stringify(native)).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY|secretHash|configurationCipher|https?:\/\//);
  });
});
