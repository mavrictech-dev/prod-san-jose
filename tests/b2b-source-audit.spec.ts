import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { b2bInventory } from '../packages/contracts/src/b2b';
// Source-only Node CLI intentionally lives outside application build graphs.
import { auditB2bSources, inspectControllerText, validateB2bInventory } from '../migration/b2b-source-audit.mjs';

describe('B2B-01: inventario verificable sin datos runtime', () => {
  it('matriz válida y no confunde modelo, laboratorio ni permiso con funcionalidad completa', () => {
    const inventory = b2bInventory();
    expect(validateB2bInventory(inventory)).toBe(inventory);
    expect(inventory.features).toHaveLength(30);
    for (const id of ['drafts', 'operations', 'sales-notes', 'customers', 'shifts-cash', 'webhooks']) {
      expect(inventory.features.find(feature => feature.id === id)?.classification).toBe('NEW');
    }
    for (const id of ['notes', 'guides', 'batches', 'mail']) expect(inventory.features.find(feature => feature.id === id)?.classification).toBe('LAB_ONLY');
  });
  it.each(['runtimeImplemented', 'status', 'environments'])('no permite presentar un contrato de fuente como runtime: %s', key => {
    const bad: any = b2bInventory(); bad[key] = key === 'runtimeImplemented' ? true : key === 'environments' ? ['PRODUCTION'] : 'ENABLED';
    expect(() => validateB2bInventory(bad)).toThrow('SOURCE_ONLY_BETA_REQUIRED');
  });
  it.each(['../outside.ts', 'C:/keys/file.ts', 'services/sunat-service/src/../../key.ts',
    'services/sunat-service/src/generated/client.ts', 'services/sunat-service/secrets/key.ts',
    'services/sunat-service/.env', 'services/sunat-service/src/credentials/key.ts'])('rechaza fuente no permitida: %s', path => {
    const bad = b2bInventory(); bad.features[0].sources[0].path = path;
    expect(() => validateB2bInventory(bad)).toThrow('SOURCE_PATH_INVALID');
  });
  it.each([
    ['classification', 'IMPLEMENTED', 'CLASSIFICATION_INVALID'],
    ['phase', 0, 'CLASSIFICATION_INVALID'],
    ['owners', [], 'OWNER_REQUIRED'],
    ['scopes', ['integration:documents:read'], 'B2B_SCOPE_INVALID'],
    ['humanPermissions', ['invented.admin'], 'HUMAN_PERMISSION_INVALID'],
    ['humanStepUp', undefined, 'STEP_UP_POLICY_REQUIRED'],
    ['gap', '', 'FEATURE_DESCRIPTION_REQUIRED'],
    ['events', ['unversioned'], 'EVENT_INVALID'],
  ])('rechaza política incompleta o confusa: %s', (key, value, message) => {
    const bad: any = b2bInventory(); bad.features[0][key] = value;
    expect(() => validateB2bInventory(bad)).toThrow(message);
  });
  it('no publica capacidades internas ni edición de documento emitido', () => {
    const internal = b2bInventory();
    internal.features.find(feature => feature.id === 'labs')!.actions.push('POST /b2b/v1/labs');
    expect(() => validateB2bInventory(internal)).toThrow('INTERNAL_CAPABILITY_CANNOT_BE_PUBLISHED');
    const issued = b2bInventory(); issued.features[0].actions.push('PATCH /b2b/v1/documents/{documentId}');
    expect(() => validateB2bInventory(issued)).toThrow('ISSUED_DOCUMENT_IMMUTABLE');
    const duplicate = b2bInventory(); duplicate.features[0].actions.push(duplicate.features[0].actions[0]);
    expect(() => validateB2bInventory(duplicate)).toThrow('ACTION_INVALID_OR_DUPLICATE');
  });
  it('parsea rutas reales con AST, ignora comentarios y admite comillas/múltiples clases', () => {
    const source = `// @Controller('fake') @Get('fake')
      @Controller("api/v1/test") class Actual {
        @Get() list() {} @Post('create') create() {} @Patch(':id') update() {}
      }
      @Controller('health') class Health { @Get() get(){} }`;
    const routes = inspectControllerText('synthetic.ts', source);
    expect(routes.map((route: any) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/v1/test', 'POST /api/v1/test/create', 'PATCH /api/v1/test/:id', 'GET /health',
    ]);
    expect(routes.every((route: any) => Number.isInteger(route.line) && route.line > 0)).toBe(true);
  });
  it('rutas dinámicas o texto inválido requieren revisión, no se omiten silenciosamente', () => {
    expect(() => inspectControllerText('synthetic.ts', '@Controller(prefix) class C { @Get() get(){} }')).toThrow('DYNAMIC_CONTROLLER_ROUTE_REQUIRES_REVIEW');
    expect(() => inspectControllerText('synthetic.ts', '@Controller("x") class {')).toThrow('SOURCE_PARSE_FAILED');
  });
  it('cubre pantallas y rutas declaradas y conserva huellas/líneas sin afirmar despliegue', async () => {
    const report = await auditB2bSources();
    expect(report).toMatchObject({ status: 'SOURCE_EVIDENCE_VERIFIED', runtimeEnabled: false, runtimeDataRead: false, credentialsRead: false, externalNetworkUsed: false, fiscalAcceptance: 'NOT_VERIFIED', controllerRegistration: 'NOT_INFERRED_FROM_DECLARATIONS' });
    expect(report.featureCount).toBe(30); expect(report.plannedActionCount).toBe(109);
    expect(report.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    const recorded = JSON.parse(readFileSync(new URL('../api-contracts/b2b/source-audit.v1.json', import.meta.url), 'utf8'));
    // Raw-byte hashes/line positions are evidence of that checkout, not portable
    // snapshots across Windows CRLF and Linux LF. Compare the semantic surface.
    const surface = (value: any) => value.routes.map(({ source, controller, method, path, handler, features, declaredAccess }: any) => ({ source, controller, method, path, handler, features, declaredAccess }));
    expect(surface(report)).toEqual(surface(recorded));
    expect(report.screens).toEqual(recorded.screens);
    expect(report.screenCount).toBe(21); expect(report.routeCount).toBeGreaterThanOrEqual(152);
    const candidate=report.routes.filter((route: any) => route.path.startsWith('/b2b/v1'));
    expect(candidate).toHaveLength(136);expect(candidate.filter((route:any)=>route.method==='GET')).toHaveLength(71);
    expect(candidate).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/b2b/v1/guide-drafts/:id/issuance' }),
      expect.objectContaining({ method: 'GET', path: '/b2b/v1/guide-drafts/:id/issuances/:operationId' }),
    ]));
    expect(report.runtimeEnabled).toBe(false); // A controller declaration is not a deployment.
    expect(report.routes.every((route: any) => route.classification !== 'FEATURE_MATRIX' || route.features.length > 0)).toBe(true);
    for (const file of report.evidence) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.anchors.every((anchor: any) => anchor.line >= 1)).toBe(true);
    }
    // Human permissions are source pointers, not an effective B2B authorization implementation.
    expect(report.classifications).toEqual({ ADAPT: 17, NEW: 6, LAB_ONLY: 4, INTERNAL_ONLY: 3 });
  });
  it('el CLI no acepta rutas arbitrarias, generación ni modos runtime', () => {
    const script = new URL('../migration/b2b-source-audit.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(script), '--runtime'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REQUIRES_SOURCE_ONLY_NO_OTHER_ARGUMENTS');
    const code = readFileSync(script, 'utf8');
    expect(code).not.toContain('process.env');
    expect(code).not.toContain('writeFile');
    expect(code).not.toContain('fetch(');
    expect(code).not.toContain('NestFactory');
  });
});
