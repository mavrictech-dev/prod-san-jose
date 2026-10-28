/** Public documentation projection. No runtime discovery, owner RPC or administrative surface. */
import { b2bReadOpenApiV1 } from './b2b-read-openapi';
import { addB2bWebhookRoutes } from './b2b-webhook-openapi';
import { B2bAudience } from './b2b';

export function b2bPublicOpenApiV1(): Record<string, any> {
  // Deliberately narrower than the full phase-8 candidate, which includes administration.
  const api = structuredClone(addB2bWebhookRoutes(b2bReadOpenApiV1()));
  api.components.schemas.EmptyCommand = { type: 'object', additionalProperties: false, properties: {}, required: [] };
  api.openapi = '3.1.0';
  api.jsonSchemaDialect = 'https://spec.openapis.org/oas/3.1/dialect/base';
  api.info = {
    title: 'FactuEz B2B · referencia de conexión', version: '1.0.0',
    description: 'Contrato de referencia de OAuth SERVICE, lectura 01/03 BETA, originales XML/CDR y webhooks locales. Runtime no verificado por esta documentación. No afirma disponibilidad, despliegue ni aceptación fiscal. La extracción privada /integration utiliza otra audiencia y otros permisos.',
  };
  api.servers = [{ url: 'https://factuez.invalid', description: 'Marcador no operativo. TI debe proporcionar el origen HTTPS privado autorizado.' }];
  api['x-documentation-state'] = 'CONTRACT_REFERENCE';
  api['x-runtime-status'] = 'NOT_PROBED_BY_DOCUMENTATION';
  api['x-runtime-enabled'] = false;
  api['x-audience'] = B2bAudience;
  api.tags = [
    { name: 'Conexión', description: 'Cliente SERVICE y contexto autorizado.' },
    { name: 'Lectura y XML/CDR', description: 'Perfil de lectura 01/03 BETA, sujeto a capacidades y originales existentes.' },
    { name: 'Webhooks', description: 'Sólo document.issued-locally.v1; no es aceptación SUNAT.' },
  ];
  api.components.securitySchemes.B2bClientBasic = { type: 'http', scheme: 'basic', description: 'client_id UUID y client_secret del cliente SERVICE, sólo desde su backend mediante transporte privado mTLS.' };
  const scopes = Object.fromEntries(Object.values(api.paths).flatMap((methods: any) => Object.values(methods).flatMap((op: any) => op['x-required-scopes'] ?? [])).map((scope: any) => [scope, scope]));
  api.components.securitySchemes.B2bOAuth = {
    type: 'oauth2', description: 'Audiencia factuez-b2b-v1. Client credentials con HTTP Basic y mTLS. El visor no autentica ni guarda tokens.',
    flows: { clientCredentials: { tokenUrl: '/b2b/oauth/token', scopes } },
  };
  const oauthError = { type: 'object', required: ['error'], properties: { error: { type: 'string', enum: ['invalid_client', 'invalid_scope', 'unsupported_grant_type', 'temporarily_unavailable', 'invalid_request'] } } };
  const tokenResponse = (schema: any, description: string) => ({ description, content: { 'application/json': { schema } } });
  api.paths['/b2b/oauth/token'] = { post: {
    operationId: 'b2bServiceToken', summary: 'Obtener token SERVICE con client credentials',
    security: [{ B2bClientBasic: [], PrivateTransport: [] }],
    description: 'HTTP Basic client_id:client_secret. Cuerpo con exactamente grant_type y scope; scopes únicos separados por un espacio, previamente concedidos. JWT RS256 de 300 segundos, sin refresh token. No acepta cookies PWA ni tokens de extracción privada.',
    requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: {
      type: 'object', additionalProperties: false, required: ['grant_type', 'scope'], properties: {
        grant_type: { type: 'string', const: 'client_credentials' },
        scope: { type: 'string', minLength: 1, description: 'Permisos b2b:* concedidos al cliente; artifacts:read requiere documents:read.', example: 'b2b:context:read b2b:catalog:read b2b:documents:read b2b:artifacts:read' },
      },
    } } } },
    responses: {
      '200': tokenResponse({ type: 'object', required: ['access_token', 'token_type', 'expires_in', 'scope'], properties: {
        access_token: { type: 'string' }, token_type: { type: 'string', const: 'Bearer' }, expires_in: { type: 'integer', const: 300 }, scope: { type: 'string' },
      } }, 'Token corto. No registrar la respuesta ni compartir credenciales.'),
      ...Object.fromEntries([400, 401, 403, 404, 413, 415, 429, 503].map(status => [String(status), tokenResponse(oauthError, 'Error OAuth seguro. El transporte privado es obligatorio.')])),
    },
  } };
  for (const [path, methods] of Object.entries(api.paths) as [string, any][]) {
    for (const op of Object.values(methods) as any[]) {
      op['x-runtime-enabled'] = false;
      op['x-runtime-status'] = 'NOT_PROBED_BY_DOCUMENTATION';
      op['x-documentation-state'] = 'CONTRACT_REFERENCE';
      op.tags = [path.includes('webhook-') ? 'Webhooks' : path === '/b2b/oauth/token' || /\/(me|capabilities)$/.test(path) ? 'Conexión' : 'Lectura y XML/CDR'];
    }
  }
  return api;
}
