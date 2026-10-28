import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { integrationOpenApiV1, integrationSwaggerV1, sunatAdministrationOpenApiV1 } from '../packages/contracts/src/integration-openapi';
import { documentationHeaders, documentationHtml, documentationInit, swaggerAssets } from '../apps/web-pwa/app/api-docs/_lib/server';
import { GET as integrationJson } from '../apps/web-pwa/app/api-docs/openapi.json/route';
import { GET as sunatJson } from '../apps/web-pwa/app/api-docs/sunat.json/route';
import { GET as html } from '../apps/web-pwa/app/api-docs/route';
import { GET as asset } from '../apps/web-pwa/app/api-docs/assets/[asset]/route';

function visit(value: unknown, work: (object: Record<string, any>) => void) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) work(value as Record<string, any>);
  for (const entry of Object.values(value)) visit(entry, work);
}
function operations(api: any) { return Object.values(api.paths).flatMap((methods: any) => Object.values(methods)) as any[]; }
function configuration() {
  let result: any;
  const bundle = Object.assign((options: any) => { result = options; }, { presets: { apis: {} } });
  vm.runInNewContext(documentationInit, { window: { location: { origin: 'http://localhost:8091' } }, SwaggerUIBundle: bundle, SwaggerUIStandalonePreset: {}, URL });
  return result;
}

describe('Swagger de referencia: contrato fiel sin activación', () => {
  it('conserva exactamente el contrato histórico y documenta los 17 endpoints implementados', () => {
    const before = integrationOpenApiV1() as any;
    const api = integrationSwaggerV1() as any;
    expect(integrationOpenApiV1()).toEqual(before);
    expect(JSON.parse(readFileSync(new URL('../api-contracts/integration/private-api.openapi.v1.json', import.meta.url), 'utf8'))).toEqual(before);
    expect(Object.keys(api.paths)).toHaveLength(17);
    expect(api['x-delivery-state']).toBe('IMPLEMENTED_OPT_IN_ACTIVATION_PENDING');
    expect(api['x-runtime-status']).toBe('NOT_PROBED_BY_DOCUMENTATION');
    expect(api.servers[0].url).toBe('https://factuez.invalid');
    expect(api.jsonSchemaDialect).toBe('https://spec.openapis.org/oas/3.1/dialect/base');
    expect(before.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
    for (const operation of operations(api)) expect(operation).toMatchObject({ 'x-implemented': true, 'x-activation-required': true });
    expect(JSON.stringify(api.info)).toContain('SOURCE_NOT_SUPPORTED');
    expect(Object.keys(api.paths).some(path => path.startsWith('/internal') || path.startsWith('/api/v1/setup'))).toBe(false);
  });
  it('los 17 métodos/rutas coinciden con los controladores de integración y token', () => {
    const normalize = (path: string) => path.replace(/\{[^}]+\}|:[A-Za-z]+/g, '{id}');
    const source = readFileSync(new URL('../services/integration-service/src/http.ts', import.meta.url), 'utf8');
    const actual = [...source.matchAll(/@(Get|Post)\('([^']+)'\)/g)].map(match => `${match[1].toLowerCase()} ${normalize('/integration/v1/' + match[2])}`);
    const identity = readFileSync(new URL('../services/identity-service/src/integration/http.ts', import.meta.url), 'utf8').split("@Controller('internal/integration')")[0];
    expect(identity).toContain("@Controller('integration/oauth')");
    expect(identity).toContain("@Post('token')");
    actual.push('post /integration/oauth/token');
    const api: any = integrationSwaggerV1();
    const documented = Object.entries(api.paths).flatMap(([path, methods]: any) => Object.keys(methods).map(method => `${method} ${normalize(path)}`));
    expect(documented.sort()).toEqual(actual.sort());
  });
  it.each([integrationSwaggerV1, sunatAdministrationOpenApiV1])('todas las referencias locales resuelven y las operaciones están protegidas', build => {
    const api: any = build();
    visit(api, value => {
      if (value.$ref) {
        expect(value.$ref).toMatch(/^#\//);
        expect(value.$ref.slice(2).split('/').reduce((target: any, part: string) => target?.[part], api), value.$ref).toBeDefined();
      }
    });
    const ids = operations(api).map(operation => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const operation of operations(api)) expect(operation.security.length).toBeGreaterThan(0);
  });
  it('no mezcla tokens humanos, ERP ni claves fiscales', () => {
    const intranet: any = sunatAdministrationOpenApiV1();
    const input = intranet.components.schemas.ConfigurationInput;
    for (const group of ['certificate', 'sol', 'gre']) for (const [name, value] of Object.entries(input.properties[group].properties) as any) {
      if (name !== 'fileName') expect(value.writeOnly, `${group}.${name}`).toBe(true);
    }
    const status = intranet.components.schemas.ConfigurationStatus.properties;
    expect(status.fiscalTransmission.const).toBe(false);
    expect(status.certificate.properties.trustAndRucVerified.const).toBe(false);
    const names = Object.keys(intranet.paths);
    expect(names.some(path => path.startsWith('/integration/'))).toBe(false);
    expect(intranet.components.securitySchemes.IntegrationOAuth).toBeUndefined();
    const namePattern = new RegExp(input.properties.certificate.properties.fileName.pattern);
    for (const name of ['test.p12', 'test.PFX', 'test.P12']) expect(namePattern.test(name)).toBe(true);
  });
  it('contrasta las rutas documentadas de SUNAT con sus controladores', () => {
    const path = '../services/sunat-service/src/';
    for (const [file, expected] of [
      ['fiscal-configuration.controller.ts', ['api/v1/setup/sunat', ':companyId/:environment', ':companyId/:environment/audit']],
      ['fiscal-readiness.controller.ts', [':companyId/:environment/readiness', ':companyId/:environment/readiness/validate']],
      ['fiscal-artifacts.controller.ts', ['api/v1/fiscal-artifacts', ':documentId/:format']],
      ['supplement-tracking.controller.ts', ['api/v1/fiscal-evidence', ':documentId']],
    ] as const) {
      const source = readFileSync(new URL(path + file, import.meta.url), 'utf8');
      for (const route of expected) expect(source).toContain(route);
    }
    const api: any = sunatAdministrationOpenApiV1();
    expect(api.paths['/api/v1/setup/sunat/{companyId}/{environment}'].post.responses['201']).toBeDefined();
    expect(api.paths['/api/v1/fiscal-artifacts/{documentId}/{format}'].get.parameters[1].schema.enum).toEqual(['ticket', 'a4']);
  });
});

describe('Visor local: sin CDN, credenciales ni ejecución de endpoints', () => {
  it('sirve landing y especificación pública sin consultar fuentes privadas', async () => {
    for (const [response, content] of [[html(), 'text/html'], [integrationJson(), 'application/json']] as const) {
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain(content);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    }
    expect((await integrationJson().json() as any)['x-runtime-status']).toBe('NOT_PROBED_BY_DOCUMENTATION');
    expect(sunatJson().status).toBe(404);
  });
  it('carga únicamente recursos locales, sin scripts inline ni entrada de contraseñas', () => {
    const source = documentationHtml();
    for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) expect(match[1]).toMatch(/^(\/|#)/);
    expect(source).not.toMatch(/<script(?![^>]*src=)/);
    expect(source).not.toContain('<input');
    expect(source).toContain('SOURCE_NOT_SUPPORTED');
    expect(documentationHeaders['Content-Security-Policy']).not.toContain('unsafe-eval');
    expect(documentationHeaders['Content-Security-Policy']).toContain("form-action 'none'");
  });
  it('deshabilita Try it out, OAuth, persistencia y validadores remotos', () => {
    const config = configuration();
    expect(config.supportedSubmitMethods).toEqual([]);
    expect(config.tryItOutEnabled).toBe(false);
    expect(config.persistAuthorization).toBe(false);
    expect(config.validatorUrl).toBeNull();
    expect(config.queryConfigEnabled).toBe(false);
    expect(config.withCredentials).toBe(false);
    expect(config.oauth2RedirectUrl).toBeUndefined();
  });
  it('permite sólo GET de las especificaciones locales y elimina cabeceras de autenticación', () => {
    const intercept = configuration().requestInterceptor;
    for (const url of ['/api-docs/openapi.json']) {
      const request = intercept({ url, headers: { Authorization: 'TEST_NOT_A_TOKEN', authorization: 'TEST_NOT_A_TOKEN' } });
      expect(request.credentials).toBe('omit');
      expect(request.headers.Authorization).toBeUndefined(); expect(request.headers.authorization).toBeUndefined();
    }
    expect(intercept({ url: '/api-docs/openapi.json' }).headers).toBeDefined();
  });
  it.each([
    ['https://factuez.invalid/integration/oauth/token', 'POST'], ['/integration/oauth/token', 'POST'],
    ['/api/v1/setup/sunat/1/BETA', 'POST'], ['/api/v1/received-documents/automation/sync', 'POST'],
    ['/api-docs/sunat.json', 'GET'], ['/api-docs/openapi.json', 'POST'], ['/api-docs/openapi.json?url=https://example.invalid', 'GET'],
    ['https://example.invalid/api-docs/openapi.json', 'GET'], ['/api-docs/unknown.json', 'GET'],
  ])('bloquea una petición fuera del visor %s %s', (url, method) => expect(() => configuration().requestInterceptor({ url, method, headers: {} })).toThrow('no ejecuta'));
  it.each(['../package.json', '__proto__', 'constructor', 'certificado.p12', 'swagger-ui.css.map'])('rechaza recursos fuera de la allowlist: %s', async value => {
    const response = await asset(new Request('http://localhost/api-docs/assets/no'), { params: Promise.resolve({ asset: value }) });
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('workspace');
  });
  it.each(Object.keys(swaggerAssets))('sirve el recurso local oficial %s', async value => {
    const response = await asset(new Request('http://localhost/api-docs/assets/no'), { params: Promise.resolve({ asset: value }) });
    expect(response.status).toBe(200); expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });
});
