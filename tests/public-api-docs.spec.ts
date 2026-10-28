import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { b2bPublicOpenApiV1 } from '../packages/contracts/src/b2b-public-openapi';
import { b2bReadOpenApiV1 } from '../packages/contracts/src/b2b-read-openapi';
import { b2bDesignOpenApiV1 } from '../packages/contracts/src/b2b-openapi';
import { addB2bWebhookRoutes } from '../packages/contracts/src/b2b-webhook-openapi';
import { validB2bBinding } from '../packages/contracts/src/b2b-security';
import { GET as landing } from '../apps/web-pwa/app/api-docs/route';
import { GET as swagger } from '../apps/web-pwa/app/api-docs/swagger/route';
import { GET as specification } from '../apps/web-pwa/app/api-docs/openapi.json/route';
import { GET as intranet } from '../apps/web-pwa/app/api-docs/sunat.json/route';
import { documentationInit, documentationHtml, swaggerHtml } from '../apps/web-pwa/app/api-docs/_lib/server';

const source = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const entries = (api: any): [string, any][] => Object.entries(api.paths).flatMap(([path, methods]: any) => Object.entries(methods).map(([method, op]) => [`${method.toUpperCase()} ${path}`, op] as [string, any]));
function visit(value: any, fn: (node: any) => void) {
  if (!value || typeof value !== 'object') return;
  fn(value); Object.values(value).forEach(child => visit(child, fn));
}
afterEach(() => vi.unstubAllGlobals());

describe('Catálogo público B2B: proyección fiel y sin activación', () => {
  it('sólo documenta los 15 métodos de lectura, los 9 de webhooks y el token de los controladores reales', () => {
    const actual = ['services/b2b-api-service/src/http.ts', 'services/b2b-api-service/src/webhooks.ts'].flatMap(file =>
      [...source(file).matchAll(/@(Get|Post|Patch)\('([^']+)'\)/g)].map(m => `${m[1].toUpperCase()} /b2b/v1/${m[2].replace(/:([A-Za-z]+)/g, '{$1}')}`));
    const identity = source('services/identity-service/src/b2b/http.ts').split("@Controller('internal/b2b')")[0];
    expect(identity).toContain("@Controller('b2b/oauth')"); expect(identity).toContain("@Post('token')");
    actual.push('POST /b2b/oauth/token');
    const api = b2bPublicOpenApiV1();
    expect(entries(api).map(([path]) => path).sort()).toEqual(actual.sort());
    expect(actual).toHaveLength(25);
    expect(JSON.stringify(api)).not.toMatch(/\/internal\/|\/api\/v1\/setup|\/integration\/v1|integrationadmin|B2bAdministrator|ConfigurationInput/);
  });
  it('conserva parámetros, scopes, cuerpos y respuestas de lectura/webhooks sin ampliar el perfil', () => {
    const original = addB2bWebhookRoutes(b2bReadOpenApiV1());
    const before = structuredClone(original), design = b2bDesignOpenApiV1();
    const api = b2bPublicOpenApiV1();
    for (const [path, methods] of Object.entries(original.paths) as [string, any][]) for (const [method, operation] of Object.entries(methods) as [string, any][]) {
      for (const key of ['operationId', 'parameters', 'security', 'x-required-scopes', 'requestBody', 'responses']) expect(api.paths[path][method][key], path + ' ' + key).toEqual(operation[key]);
    }
    for (const [name, schema] of Object.entries(original.components.schemas)) expect(api.components.schemas[name], name).toEqual(schema);
    expect(original).toEqual(before); expect(b2bDesignOpenApiV1()).toEqual(design);
    expect(api.components.schemas.Coverage.properties.unsupported.const).toEqual(['07', '08', '09', '31']);
    expect(api.components.schemas.HookCreate.properties.events.const).toEqual(['document.issued-locally.v1']);
    api.components.schemas.Document.properties.id.type = 'MUTATED';
    expect(b2bPublicOpenApiV1().components.schemas.Document.properties.id.type).toBe('string');
  });
  it('resuelve referencias y seguridad, mantiene IDs únicos y marca runtime sin sondear en cada operación', () => {
    const api = b2bPublicOpenApiV1();
    const ids = entries(api).map(([, op]) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(api.servers[0].url).toBe('https://factuez.invalid');
    expect(api['x-documentation-state']).toBe('CONTRACT_REFERENCE');
    expect(api['x-runtime-enabled']).toBe(false);
    expect(api['x-runtime-status']).toBe('NOT_PROBED_BY_DOCUMENTATION');
    visit(api, node => {
      if (node.$ref) {
        expect(node.$ref).toMatch(/^#\//);
        expect(node.$ref.slice(2).split('/').reduce((target: any, key: string) => target?.[key], api), node.$ref).toBeDefined();
      }
    });
    for (const [, op] of entries(api)) {
      expect(op['x-runtime-enabled']).toBe(false);
      expect(op['x-runtime-status']).toBe('NOT_PROBED_BY_DOCUMENTATION');
      for (const alternative of op.security) {
        expect(alternative.PrivateTransport).toEqual([]);
        for (const name of Object.keys(alternative)) expect(api.components.securitySchemes[name]).toBeDefined();
      }
    }
  });
  it('OAuth coincide con HTTP Basic, dos campos form, audiencia B2B y vigencia de 300 segundos', () => {
    const api = b2bPublicOpenApiV1(), op = api.paths['/b2b/oauth/token'].post;
    expect(api['x-audience']).toBe('factuez-b2b-v1');
    expect(op.security).toEqual([{ B2bClientBasic: [], PrivateTransport: [] }]);
    const input = op.requestBody.content['application/x-www-form-urlencoded'].schema;
    expect(input.required).toEqual(['grant_type', 'scope']); expect(input.additionalProperties).toBe(false);
    expect(input.properties.grant_type.const).toBe('client_credentials');
    const output = op.responses['200'].content['application/json'].schema;
    expect(output.properties.expires_in.const).toBe(300); expect(output.properties.refresh_token).toBeUndefined();
    expect(op.responses['403'].content['application/json'].schema.required).toEqual(['error']);
    expect(source('services/identity-service/src/b2b/service.ts')).toContain("Object.keys(body).sort().join(',') !== 'grant_type,scope'");
    expect(source('services/identity-service/src/b2b/service.ts')).toContain("expires_in: 300");
  });
});

describe('Landing, acceso Swagger y privacidad sin red ni credenciales', () => {
  it('sirve HTML y JSON puros sin consultas, y no entrega el antiguo contrato intranet', async () => {
    const fetch = vi.fn(() => { throw new Error('Red real prohibida'); }); vi.stubGlobal('fetch', fetch);
    for (const [response, media] of [[landing(), 'text/html'], [swagger(), 'text/html'], [specification(), 'application/json']] as const) {
      expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toContain(media);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Content-Security-Policy')).toContain("form-action 'none'");
    }
    expect(await specification().json()).toEqual(b2bPublicOpenApiV1());
    const closed = intranet(); expect(closed.status).toBe(404);
    expect(await closed.text()).not.toMatch(/openapi|Configuration|SUNAT|\/internal/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('la guía funciona sin JavaScript y enlaza secciones, Swagger y JSON locales', () => {
    const html = documentationHtml();
    expect(html).not.toContain('<script');
    for (const id of ['conexion', 'oauth', 'xml-cdr', 'webhooks', 'errores']) {
      expect(html).toContain(`href="#${id}"`); expect(html).toContain(`id="${id}"`);
    }
    for (const url of ['/api-docs/swagger', '/api-docs/openapi.json']) expect(html).toContain(`href="${url}"`);
    expect(html).toContain('Runtime no verificado'); expect(html).toContain('SOURCE_NOT_SUPPORTED');
    expect(html).not.toMatch(/\/internal\/|sunat\.json|\/sunat-settings|\/integration\/oauth|<input|<form/);
    const viewer = swaggerHtml();
    expect(viewer).toContain('id="swagger-ui"'); expect(viewer).toContain('<noscript>');
    for (const match of viewer.matchAll(/<script[^>]*src="([^"]+)"/g)) expect(match[1]).toMatch(/^\/api-docs\/assets\//);
  });
  it('los ejemplos HTTP sólo usan métodos y parámetros del contrato publicado', () => {
    const html = documentationHtml(), api = b2bPublicOpenApiV1();
    const unescape = (s: string) => s.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    const calls = [...html.matchAll(/(GET|POST) (\/b2b\/[^\s<]+(?:&lt;[^;]+?&gt;[^\s<]*)*)/g)];
    expect(calls.length).toBeGreaterThan(5);
    // Validate the complete extraction code block, including required issuerId/environment.
    const block = unescape(html.match(/aria-label="Recorrido de extracción B2B"><code>([\s\S]*?)<\/code>/)![1]);
    for (const line of block.split('\n')) {
      const [method, address] = line.split(' '), [path, query] = address.split('?');
      const template = path.replace(/<(?:DOCUMENT|ARTIFACT)_UUID>/g, '{id}');
      const operation = api.paths[template]?.[method.toLowerCase()]; expect(operation, template).toBeDefined();
      const params = new URLSearchParams(query);
      for (const param of operation.parameters.filter((p: any) => p.in === 'query' && p.required)) expect(params.has(param.name), template + ':' + param.name).toBe(true);
      for (const name of params.keys()) expect(operation.parameters.some((p: any) => p.in === 'query' && p.name === name)).toBe(true);
    }
  });
  it('el cuerpo de suscripción satisface el Context real con todos los campos obligatorios', () => {
    const html = documentationHtml();
    const raw = html.match(/aria-label="Cuerpo de alta de suscripción con marcadores"><code>([\s\S]*?)<\/code>/)![1];
    const uuid = '11111111-1111-4111-8111-111111111111';
    const example = JSON.parse(raw.replaceAll('&lt;ISSUER_ID&gt;', '1').replaceAll('&lt;RUC_AUTORIZADO&gt;', '20123456789').replace(/&lt;(?:BRANCH|POINT|SERIES)_UUID&gt;/g, uuid).replaceAll('&lt;DESTINO_APROBADO&gt;', 'erp-aprobado'));
    expect(validB2bBinding(example.binding)).toBe(true);
    const api = b2bPublicOpenApiV1(), schema = api.components.schemas.HookCreate;
    expect(Object.keys(example).sort()).toEqual(schema.required.slice().sort());
    expect(Object.keys(example.binding).sort()).toEqual(api.components.schemas.Context.required.slice().sort());
    expect(example.events).toEqual(schema.properties.events.const);
  });
  it('el visor no permite cambiar spec, autenticar, ejecutar ni conservar cabeceras o tokens', () => {
    let config: any;
    const bundle = Object.assign((options: any) => { config = options; }, { presets: { apis: {} } });
    vm.runInNewContext(documentationInit, { window: { location: { origin: 'https://docs.invalid' } }, SwaggerUIBundle: bundle, URL });
    expect(config.url).toBe('/api-docs/openapi.json'); expect(config.urls).toBeUndefined();
    expect(config.supportedSubmitMethods).toEqual([]); expect(config.tryItOutEnabled).toBe(false);
    expect(config.persistAuthorization).toBe(false); expect(config.queryConfigEnabled).toBe(false); expect(config.validatorUrl).toBeNull();
    expect(config.requestInterceptor({ url: config.url, headers: { Authorization: 'SYNTHETIC', Cookie: 'SYNTHETIC', 'X-Api-Key': 'SYNTHETIC' } })).toMatchObject({ credentials: 'omit', headers: {} });
    for (const url of ['/api-docs/sunat.json', '/internal/b2b/clients', '/b2b/oauth/token', 'https://other.invalid/api-docs/openapi.json', '/api-docs/openapi.json?url=x', '/api-docs/openapi.json#x', 'https://u:p@docs.invalid/api-docs/openapi.json']) {
      expect(() => config.requestInterceptor({ url, method: 'GET' }), url).toThrow('no ejecuta');
    }
    expect(() => config.requestInterceptor({ url: config.url, method: 'POST' })).toThrow('no ejecuta');
  });
});
