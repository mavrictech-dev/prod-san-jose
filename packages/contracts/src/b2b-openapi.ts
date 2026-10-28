/** Proposed first vertical slice only. Never mounted as an operational Swagger document. */
import { B2bAudience, B2bContractState, B2bContractVersion, B2bErrorCodes, B2bOperationStates } from './b2b';
import { b2bWebhookSchemas } from './b2b-webhooks';
type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const text = (maxLength = 200): Schema => ({ type: 'string', minLength: 1, maxLength });
const uuid: Schema = { type: 'string', format: 'uuid' };
const issuerId: Schema = { type: 'integer', minimum: 1, description: 'Identificador numérico canónico de CompanySettings en Billing, no UUID.' };
const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object', additionalProperties: false, properties,
  required: Object.keys(properties).filter(key => !optional.includes(key)),
});
const array = (items: Schema, maxItems = 100): Schema => ({ type: 'array', items, maxItems });
const enumeration = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] });
const timestamp: Schema = { type: 'string', format: 'date-time' };
const money: Schema = { type: 'string', pattern: '^[0-9]+\\.[0-9]{2}$' };
const revision: Schema = { type: 'string', pattern: '^"v[1-9][0-9]*"$', description: 'ETag fuerte opaco; no derivarlo de fecha.' };
const context = { issuerId, branchId: uuid, pointId: uuid, seriesId: uuid, environment: { type: 'string', const: 'BETA' } };
const customer = object({ identityType: enumeration(['0', '1', '6']), identityNumber: text(15), legalName: text(250), address: text(300), email: { type: 'string', format: 'email', maxLength: 254 } }, ['address', 'email']);
const line = object({
  productId: uuid, productCode: text(100), description: text(500), unitCode: text(8),
  quantity: { type: 'string', pattern: '^[0-9]{1,12}(\\.[0-9]{1,6})?$', description: 'Debe ser > 0; validación semántica del propietario.' },
  unitPriceWithTax: { type: 'string', pattern: '^[0-9]{1,12}(\\.[0-9]{1,6})?$' },
  taxAffectationCode: { type: 'string', const: '10' }, igvRate: { type: 'string', const: '18' },
}, ['productId', 'productCode']);
const lines: Schema = { ...array(line), minItems: 1 };
const externalReference = object({ namespace: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' }, value: text(120) });
const draftFields = { customer, lines, issueDate: { type: 'string', format: 'date' } };
const documentStateFields = { documentId: uuid, local: enumeration(['ISSUED', 'CANCELLED']), transport: enumeration(['PENDING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'UNKNOWN']), updatedAt: timestamp };
const problem = (description: string) => ({ description, content: { 'application/json': { schema: ref('Error') } } });
const json = (name: string, description: string, headers?: Record<string, unknown>) => ({
  description, ...(headers ? { headers } : {}), content: { 'application/json': { schema: ref(name) } },
});
const etagHeader = { ETag: { required: true, schema: revision } };
const idempotency = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' }, description: 'Clave estable del cliente; namespace interno por cliente/actor, emisor y operación. Mismo cuerpo: misma respuesta; otro cuerpo: 409.' };
const ifMatch = { name: 'If-Match', in: 'header', required: true, schema: revision };

export function b2bDesignOpenApiV1() {
  const schemas: Record<string, Schema> = {
    Error: object({ schemaVersion: { type: 'string', const: B2bContractVersion }, requestId: uuid, code: enumeration(B2bErrorCodes), message: text(300), retryable: { type: 'boolean' } }),
    Context: object(context),
    DraftCreate: object({ ...context, documentType: enumeration(['01', '03']), currency: enumeration(['PEN', 'USD']), paymentTerms: { type: 'string', const: 'CONTADO' }, externalReference, ...draftFields }),
    DraftPatch: { ...object(draftFields, Object.keys(draftFields)), minProperties: 1 },
    EmptyCommand: object({}),
    Draft: object({ schemaVersion: { type: 'string', const: B2bContractVersion }, id: uuid, context: ref('Context'), revision, documentType: enumeration(['01', '03']), currency: enumeration(['PEN', 'USD']), paymentTerms: { type: 'string', const: 'CONTADO' }, externalReference, ...draftFields, state: enumeration(['DRAFT', 'CANCELLED', 'ISSUED']) }),
    Validation: object({ draftId: uuid, revision, profile: { type: 'string', const: 'BETA_01_03_TAXABLE18_V1' }, valid: { type: 'boolean' }, issues: array(object({ code: text(80), field: text(200), message: text(300) })), fiscalActivation: { type: 'boolean', const: false } }),
    Operation: object({ schemaVersion: { type: 'string', const: B2bContractVersion }, operationId: uuid, commandId: uuid, requestId: uuid, environment: { type: 'string', const: 'BETA' }, state: enumeration(B2bOperationStates), fiscalAcceptance: { type: 'string', const: 'NOT_ASSERTED' }, resourceId: { anyOf: [uuid, { type: 'null' }] } }),
    Me: object({ clientId: uuid, actor: { oneOf: [object({ kind: { type: 'string', const: 'SERVICE' } }), object({ kind: { type: 'string', const: 'USER' }, subjectId: uuid })] }, effectiveScopes: array(text(80)), grantRevision: text(100) }),
    Capabilities: object({ schemaVersion: { type: 'string', const: B2bContractVersion }, environment: { type: 'string', const: 'BETA' }, features: array(object({ id: text(100), state: enumeration(['ENABLED', 'DISABLED', 'NOT_IMPLEMENTED', 'BLOCKED_BY_PROFILE']), reason: text(300) })), fiscalActivation: { type: 'boolean', const: false } }),
    Issuer: object({ id: issuerId, ruc: { type: 'string', pattern: '^[0-9]{11}$' }, legalName: text(500), environment: { type: 'string', const: 'BETA' } }),
    Branch: object({ id: uuid, issuerId, code: text(30), name: text(300) }),
    Point: object({ id: uuid, issuerId, branchId: uuid, code: text(30), name: text(300) }),
    Series: object({ id: uuid, issuerId, branchId: uuid, pointId: uuid, type: enumeration(['01', '03']), label: { type: 'string', pattern: '^[FB][A-Z0-9]{3}$' } }),
    Document: object({ id: uuid, context: ref('Context'), documentType: enumeration(['01', '03']), fullNumber: text(32), resourceVersion: text(100), issuer: object({ ruc: { type: 'string', pattern: '^[0-9]{11}$' }, legalName: text(500), address: text(1000) }), customer, lines, issueDate: draftFields.issueDate, issueTime: { anyOf: [{ type: 'string', pattern: '^[0-9]{2}:[0-9]{2}:[0-9]{2}$' }, { type: 'null' }] }, currency: enumeration(['PEN', 'USD']), paymentTerms: { type: 'string', const: 'CONTADO' }, totals: object({ taxableAmount: money, igvAmount: money, payableAmount: money }), state: ref('DocumentStatus') }),
    DocumentStatus: { oneOf: [
      object({ ...documentStateFields, fiscal: { type: 'string', const: 'NOT_VERIFIED' }, provenance: enumeration(['LOCAL', 'LOCAL_SIMULATOR', 'SUNAT_BETA']) }),
      object({ ...documentStateFields, fiscal: enumeration(['ACCEPTED_VERIFIED', 'REJECTED_VERIFIED']), provenance: { type: 'string', const: 'SUNAT_BETA' }, evidence: object({ artifactId: uuid, signature: { type: 'string', const: 'VERIFIED' }, trust: { type: 'string', const: 'VERIFIED' }, identity: { type: 'string', const: 'MATCHED' }, binding: { type: 'string', const: 'VERIFIED' }, checkedAt: timestamp }) }),
    ] },
    Artifact: object({ id: uuid, kind: enumeration(['SIGNED_XML', 'CDR_XML', 'SUBMISSION_ZIP', 'PDF_A4', 'PDF_TICKET']), representation: enumeration(['ORIGINAL', 'CURRENT']), availability: enumeration(['AVAILABLE', 'MISSING', 'PENDING', 'NOT_SUPPORTED']), sha256: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] }, provenance: enumeration(['LOCAL', 'LOCAL_SIMULATOR', 'SUNAT_BETA']) }),
    ...b2bWebhookSchemas(),
  };
  for (const name of ['Issuer', 'Branch', 'Point', 'Series', 'Document', 'Artifact']) {
    schemas[`${name}Page`] = object({ items: array(ref(name)), nextCursor: { anyOf: [text(4096), { type: 'null' }] }, complete: { type: 'boolean' } });
  }
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (method: string, path: string, operationId: string, scope: string, response: string, options: { body?: string; revision?: boolean; created?: boolean; async?: boolean; query?: string[]; paged?: boolean; binary?: boolean } = {}) => {
    const params: Record<string, unknown>[] = [...path.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: uuid }));
    if (method !== 'get') params.push(idempotency);
    if (options.revision) params.push(ifMatch);
    for (const name of options.query ?? []) params.push({ name, in: 'query', required: true, schema: name === 'issuerId' ? issuerId : name.endsWith('Id') ? uuid : text(100) });
    if (options.paged) {
      params.push({ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } });
      params.push({ name: 'cursor', in: 'query', schema: text(4096) });
    }
    if (method === 'get' && path !== '/me') params.push({ name: 'environment', in: 'query', required: true, schema: { type: 'string', const: 'BETA' } });
    const status = options.async ? '202' : options.created ? '201' : '200';
    const responses: Record<string, unknown> = {
      [status]: options.binary ? {
        description: 'Archivo privado sólo si existe y está autorizado; nunca P12 ni credenciales.',
        headers: { 'Cache-Control': { schema: { type: 'string', const: 'private, no-store' } } },
        content: Object.fromEntries(['application/xml', 'application/zip', 'application/pdf'].map(media => [media, { schema: { type: 'string', format: 'binary' } }])),
      } : json(response, options.async ? 'Comando registrado, NO aceptación de SUNAT.' : 'Respuesta propuesta; esta ruta no está implementada.', response === 'Draft' ? etagHeader : undefined),
      '400': problem('Solicitud o perfil inválido.'), '401': problem('Credencial inválida o audiencia incorrecta.'),
      '403': problem('Permiso/alcance insuficiente.'), '404': problem('Recurso inexistente o no visible.'),
      '409': problem('Conflicto de idempotencia, estado o documento inmutable.'),
      '412': problem('Revisión no coincide.'), '429': problem('Límite de uso alcanzado.'),
      '501': problem('Operación aún no implementada.'), '503': problem('Propietario no disponible o perfil bloqueado.'),
    };
    (paths[`/b2b/v1${path}`] ??= {})[method] = {
      operationId, summary: operationId, tags: [path.split('/')[1]],
      'x-implementation-state': B2bContractState, 'x-required-scopes': [scope],
      security: [{ B2bBearer: [] }], parameters: params, responses,
      ...(options.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(options.body) } } } } : {}),
    };
  };
  add('get', '/me', 'getB2bMe', 'b2b:context:read', 'Me');
  add('get', '/capabilities', 'getB2bCapabilities', 'b2b:context:read', 'Capabilities');
  add('get', '/issuers', 'listB2bIssuers', 'b2b:catalog:read', 'IssuerPage', { paged: true });
  add('get', '/branches', 'listB2bBranches', 'b2b:catalog:read', 'BranchPage', { query: ['issuerId'], paged: true });
  add('get', '/points', 'listB2bPoints', 'b2b:catalog:read', 'PointPage', { query: ['issuerId', 'branchId'], paged: true });
  add('get', '/series', 'listB2bSeries', 'b2b:catalog:read', 'SeriesPage', { query: ['issuerId', 'pointId'], paged: true });
  add('post', '/document-drafts', 'createB2bDraft', 'b2b:drafts:write', 'Draft', { body: 'DraftCreate', created: true });
  add('get', '/document-drafts/{draftId}', 'getB2bDraft', 'b2b:drafts:write', 'Draft');
  add('patch', '/document-drafts/{draftId}', 'patchB2bDraft', 'b2b:drafts:write', 'Draft', { body: 'DraftPatch', revision: true });
  add('post', '/document-drafts/{draftId}/validate', 'validateB2bDraft', 'b2b:drafts:write', 'Validation', { body: 'EmptyCommand', revision: true });
  add('post', '/document-drafts/{draftId}/cancel', 'cancelB2bDraft', 'b2b:drafts:write', 'Draft', { body: 'EmptyCommand', revision: true });
  add('post', '/document-drafts/{draftId}/issue', 'issueB2bDraft', 'b2b:documents:issue', 'Operation', { body: 'EmptyCommand', revision: true, async: true });
  add('get', '/documents', 'listB2bDocuments', 'b2b:documents:read', 'DocumentPage', { query: ['issuerId'], paged: true });
  add('get', '/documents/lookup', 'lookupB2bDocument', 'b2b:documents:read', 'Document', { query: ['issuerId', 'type', 'series', 'number'] });
  add('get', '/documents/{documentId}', 'getB2bDocument', 'b2b:documents:read', 'Document');
  add('get', '/documents/{documentId}/status', 'getB2bDocumentStatus', 'b2b:documents:read', 'DocumentStatus');
  add('get', '/documents/{documentId}/artifacts', 'listB2bDocumentArtifacts', 'b2b:artifacts:read', 'ArtifactPage', { paged: true });
  add('get', '/batches/{batchId}/artifacts', 'listB2bBatchArtifacts', 'b2b:artifacts:read', 'ArtifactPage', { paged: true });
  add('get', '/artifacts/{artifactId}/content', 'downloadB2bArtifact', 'b2b:artifacts:read', '', { binary: true });
  add('get', '/operations/{operationId}', 'getB2bOperation', 'b2b:operations:read', 'Operation');
  add('get', '/operations/lookup', 'lookupB2bOperation', 'b2b:operations:read', 'Operation', { query: ['issuerId', 'idempotencyKey'] });
  return structuredClone({
    openapi: '3.1.0', jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: { title: 'FactuEz B2B — contrato de diseño, no operativo', version: B2bContractVersion,
      description: 'B2B-01. Primer corte 01/03 IGV 18% Beta. Ninguna ruta de este archivo está habilitada. No es el contrato readonly /integration/v1. Validación semántica y permisos dentro del propietario. WebhookEvent es esquema propuesto de callbacks, no un endpoint de recepción de FactuEz.' },
    // Deliberately no servers, tokenUrl, credentials or guessed issuer URLs.
    'x-implementation-state': B2bContractState, 'x-audience': B2bAudience,
    'x-environments': ['BETA'], 'x-runtime-enabled': false,
    paths, components: { schemas, securitySchemes: { B2bBearer: {
      type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
      description: 'Audiencia factuez-b2b-v1, autenticación y permisos vigentes verificados por Identity/propietarios. Emisor OIDC y flujo en B2B-02; no acepta tokens de extracción ni cookies PWA.',
    } } },
  });
}

// Curated documentation only; the candidate contract above remains unchanged.
export { b2bPublicOpenApiV1 } from './b2b-public-openapi';
