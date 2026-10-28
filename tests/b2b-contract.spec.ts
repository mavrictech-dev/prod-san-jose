import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { B2bAudience, B2bContractState, B2bOperationStates, B2bRequiredInvariants, b2bInventory, b2bScopeCatalog } from '../packages/contracts/src/b2b';
import { b2bDesignOpenApiV1 } from '../packages/contracts/src/b2b-openapi';
import { B2bWebhookEventNames, b2bWebhookCatalog, b2bWebhookSchemas } from '../packages/contracts/src/b2b-webhooks';
import { IntegrationScopes } from '../packages/contracts/src/integration-extraction';
import { integrationOpenApiV1 } from '../packages/contracts/src/integration-openapi';
import { PermissionCodes, DefaultRolePermissions } from '../packages/contracts/src/authorization';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const api = () => b2bDesignOpenApiV1() as any;
const operations = (doc: any) => Object.entries(doc.paths).flatMap(([path, methods]: any) =>
  Object.entries(methods).map(([method, operation]: any) => ({ path, method, ...operation })));
function visit(value: any, work: (object: any) => void) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) work(value);
  for (const child of Object.values(value)) visit(child, work);
}

describe('B2B-01: contrato separado y explícitamente no operativo', () => {
  it('archivos de referencia coinciden exactamente con sus generadores versionados', () => {
    expect(api()).toEqual(JSON.parse(read('api-contracts/b2b/openapi.design.v1.json')));
    expect(b2bWebhookCatalog()).toEqual(JSON.parse(read('api-contracts/b2b/webhooks.design.v1.json')));
  });
  it('describe el primer corte sin anunciar rutas habilitadas ni servidores ficticios', () => {
    const doc = api();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc['x-implementation-state']).toBe(B2bContractState);
    expect(doc['x-runtime-enabled']).toBe(false);
    expect(doc['x-environments']).toEqual(['BETA']);
    expect(doc['x-audience']).toBe(B2bAudience);
    expect(doc).not.toHaveProperty('servers');
    expect(doc).not.toHaveProperty('externalDocs');
    expect(operations(doc)).toHaveLength(21);
  });
  it('cada ruta diseñada pertenece a una acción del inventario, con scope propio', () => {
    const inventory = b2bInventory();
    for (const operation of operations(api())) {
      const feature = inventory.features.find(feature => feature.actions.includes(`${operation.method.toUpperCase()} ${operation.path}`));
      expect(feature, operation.operationId).toBeDefined();
      expect(feature!.scopes).toEqual(expect.arrayContaining(operation['x-required-scopes']));
      expect(operation['x-implementation-state']).toBe(B2bContractState);
      expect(operation.security).toEqual([{ B2bBearer: [] }]);
    }
  });
  it('referencias locales resolubles e identificadores de operación únicos', () => {
    const doc = api();
    visit(doc, value => {
      if (value.$ref) {
        expect(value.$ref).toMatch(/^#\/components\/schemas\//);
        expect(value.$ref.slice(2).split('/').reduce((current: any, key: string) => current?.[key], doc)).toBeDefined();
      }
    });
    const ids = operations(doc).map(operation => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it.each(operations(api()).map(operation => [operation.operationId, operation]))('%s tiene parámetros y errores explícitos', (_, operation: any) => {
    const pathVariables = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match: any) => match[1]).sort();
    expect(operation.parameters.filter((p: any) => p.in === 'path').map((p: any) => p.name).sort()).toEqual(pathVariables);
    expect(new Set(operation.parameters.map((p: any) => `${p.in}:${p.name}`)).size).toBe(operation.parameters.length);
    for (const status of ['400', '401', '403', '404', '409', '412', '429', '501', '503']) expect(operation.responses[status]).toBeDefined();
    if (operation.method !== 'get') {
      expect(operation.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })]));
      expect(operation.requestBody.required).toBe(true);
      if (!operation.path.endsWith('/document-drafts')) expect(operation.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'If-Match', required: true })]));
    }
  });
  it('no expone PATCH/DELETE de comprobantes emitidos ni reinicio de correlativos', () => {
    for (const operation of operations(api())) {
      expect(operation.method).not.toBe('delete');
      if (operation.method === 'patch') expect(operation.path).toBe('/b2b/v1/document-drafts/{draftId}');
      expect(operation.path).not.toMatch(/reset|counter|secrets|laboratory|qa|production/i);
    }
    const schemas = api().components.schemas;
    for (const name of ['DraftCreate', 'DraftPatch']) {
      expect(schemas[name].additionalProperties).toBe(false);
      for (const field of ['number', 'fullNumber', 'userId', 'role', 'roles', 'permissions', 'nextNumber', 'sunatStatus', 'issuerRuc']) expect(schemas[name].properties).not.toHaveProperty(field);
    }
    expect(schemas.DraftPatch.minProperties).toBe(1);
  });
  it('borrador exige contexto canónico y limita el primer perfil a 01/03 IGV18 contado', () => {
    const create = api().components.schemas.DraftCreate;
    expect(create.required).toEqual(expect.arrayContaining(['issuerId', 'branchId', 'pointId', 'seriesId', 'environment', 'externalReference', 'customer', 'lines', 'paymentTerms']));
    expect(create.properties.documentType.enum).toEqual(['01', '03']);
    expect(create.properties.environment.const).toBe('BETA');
    expect(create.properties.paymentTerms.const).toBe('CONTADO');
    const line = create.properties.lines.items;
    expect(line.additionalProperties).toBe(false);
    expect(line.properties.taxAffectationCode.const).toBe('10');
    expect(line.properties.igvRate.const).toBe('18');
    for (const field of ['quantity', 'unitPriceWithTax']) {
      expect(line.properties[field].type).toBe('string');
      expect('1.234567').toMatch(new RegExp(line.properties[field].pattern));
      expect('1e5').not.toMatch(new RegExp(line.properties[field].pattern));
      expect('-1').not.toMatch(new RegExp(line.properties[field].pattern));
    }
    expect(create.properties.lines.minItems).toBe(1); expect(create.properties.lines.maxItems).toBe(100);
  });
  it('202 y operación no equivalen a aceptación fiscal', () => {
    const doc = api();
    const issue = doc.paths['/b2b/v1/document-drafts/{draftId}/issue'].post;
    expect(issue.responses['202'].description).toContain('NO aceptación');
    expect(issue.responses['200']).toBeUndefined();
    expect(doc.components.schemas.Operation.properties.fiscalAcceptance.const).toBe('NOT_ASSERTED');
    expect(doc.components.schemas.Operation.properties.state.enum).toEqual([...B2bOperationStates]);
    expect(B2bOperationStates).toContain('UNKNOWN_REQUIRES_RECONCILIATION');
    const variants = doc.components.schemas.DocumentStatus.oneOf;
    expect(variants[0].properties.fiscal.const).toBe('NOT_VERIFIED');
    expect(variants[1].properties.fiscal.enum).toEqual(['ACCEPTED_VERIFIED', 'REJECTED_VERIFIED']);
    expect(variants[1].properties.provenance.const).toBe('SUNAT_BETA');
    expect(variants[1].required).toContain('evidence');
  });
  it('esquemas cerrados, sin campos de secretos ni importes float', () => {
    visit(api().components.schemas, value => {
      if (value.type === 'object') {
        expect(value.additionalProperties).toBe(false);
        expect(value.required.every((key: string) => key in value.properties)).toBe(true);
        for (const key of Object.keys(value.properties)) expect(key).not.toMatch(/password|secret|p12|pfx|solKey|accessToken|privateKey|downloadUrl/i);
      }
      if (value.type) expect(value.type).not.toBe('number');
    });
  });
  it('audiencia/scopes B2B no amplían permisos ni tokens legacy', () => {
    expect(B2bAudience).not.toBe('factuez-integration-v1');
    expect(b2bScopeCatalog().some(scope => (IntegrationScopes as readonly string[]).includes(scope))).toBe(false);
    expect(Object.values(PermissionCodes).some(scope => scope.startsWith('b2b:'))).toBe(false);
    expect(Object.values(DefaultRolePermissions).flat().some(scope => scope.startsWith('b2b:'))).toBe(false);
    expect(integrationOpenApiV1()).toEqual(JSON.parse(read('api-contracts/integration/private-api.openapi.v1.json')));
    const rootExports = read('packages/contracts/src/index.ts');
    expect(rootExports).not.toContain('./b2b');
    const kong = read('infra/kong/kong.yml');
    expect(kong).not.toContain('/b2b/v1');
    expect(read('services/sunat-service/src/application/fiscal-readiness.service.ts')).toContain('assertOfficialFiscalActivation(): never');
  });
  it('objetos devueltos se pueden inspeccionar sin mutar el catálogo original', () => {
    const first = api(); first.components.schemas.DraftCreate.properties.environment.const = 'PRODUCTION';
    expect(api().components.schemas.DraftCreate.properties.environment.const).toBe('BETA');
    const inventory = b2bInventory(); inventory.features[0].scopes.push('b2b:injected:write');
    expect(b2bScopeCatalog()).not.toContain('b2b:injected:write');
  });
  it('invariantes obligatorios no se confunden con controles ya implementados', () => {
    expect(Object.values(B2bRequiredInvariants).every(value => value === true)).toBe(true);
    expect(b2bInventory().runtimeImplemented).toBe(false);
    for (const id of ['issuers-admin', 'users-admin', 'fiscal-admin', 'smtp-admin', 'print-branding', 'received-automation']) {
      expect(b2bInventory().features.find(feature => feature.id === id)?.humanStepUp).toBe(true);
    }
  });
});

describe('B2B-01: eventos externos mínimos y procedencia', () => {
  it('el inventario declara exactamente los eventos versionados del catálogo', () => {
    const events = [...new Set(b2bInventory().features.flatMap(feature => feature.events))].sort();
    expect(events).toEqual([...B2bWebhookEventNames].sort());
  });
  it.each(B2bWebhookEventNames)('%s tiene esquema cerrado, versión y entorno, sin snapshot/PII', eventName => {
    const variants = (b2bWebhookSchemas().WebhookEvent as any).oneOf;
    const variant = variants.find((variant: any) => variant.properties.eventName.const === eventName);
    expect(variant.additionalProperties).toBe(false);
    expect(variant.properties.environment.const).toBe('BETA');
    expect(variant.required).toContain('eventId');
    const payload = variant.properties.payload;
    expect(payload.additionalProperties).toBe(false);
    for (const key of ['customer', 'items', 'issuerRuc', 'xml', 'cdr', 'email', 'downloadUrl', 'token']) expect(payload.properties).not.toHaveProperty(key);
    if (eventName.includes('-verified.')) {
      const evidence = payload.properties.evidence;
      expect(evidence.properties.provenance.const).toBe('SUNAT_BETA');
      expect(evidence.properties.signature.const).toBe('VERIFIED');
      expect(evidence.properties.trust.const).toBe('VERIFIED');
      expect(evidence.properties.binding.const).toBe('VERIFIED');
      expect(evidence.properties.identity.const).toBe('MATCHED');
      expect(evidence.required).toContain('artifactId');
      expect(evidence.properties.outcome.const).toBe(eventName.includes('acceptance') ? 'ACCEPTED' : 'REJECTED');
    } else expect(payload.properties.provenance.enum).toContain('LOCAL_SIMULATOR');
  });
  it('define firma sobre bytes exactos, reintentos acotados y entrega no exactly-once', () => {
    const catalog = b2bWebhookCatalog();
    expect(catalog.status).toBe('DESIGN_ONLY_NOT_IMPLEMENTED');
    expect(catalog.delivery.semantics).toBe('AT_LEAST_ONCE');
    expect(catalog.delivery.signature.headers).toEqual(['webhook-id', 'webhook-timestamp', 'webhook-signature']);
    expect(catalog.delivery.signature.signedContent).toContain('exactRawBody');
    expect(catalog.delivery.signature.webhookIdValue).toBe('deliveryId');
    expect(catalog.delivery.redirectsAllowed).toBe(false);
    expect(catalog.delivery.currentGrantRequired).toBe(true);
    expect(catalog.delivery.maxAttempts).toBe(8);
    expect(catalog.delivery.payloadContainsDownloadUrls).toBe(false);
  });
});
