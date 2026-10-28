import { IntegrationArtifactKinds, IntegrationContractVersion, IntegrationDocumentTypes, IntegrationErrors, IntegrationFiscalStates, IntegrationLimits, IntegrationPatterns, IntegrationScopes } from './integration-extraction';
export { sunatAdministrationOpenApiV1 } from './sunat-openapi';

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const text = (maxLength = 300): Schema => ({ type: 'string', maxLength });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const values = (enumeration: readonly string[]): Schema => ({ type: 'string', enum: [...enumeration] });
const array = (items: Schema, maxItems = 10000): Schema => ({ type: 'array', items, maxItems });
const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter(k => !optional.includes(k)) });
const date: Schema = { type: 'string', format: 'date', pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' };
const time = nullable({ type: 'string', pattern: '^[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?$' });
const timestamp: Schema = { type: 'string', format: 'date-time' };
const uuid: Schema = { type: 'string', format: 'uuid', pattern: IntegrationPatterns.uuid };
const decimal = nullable({ type: 'string', pattern: IntegrationPatterns.decimal, description: 'Decimal exacto como texto; nunca float. null significa no disponible, no cero.' });
const ns = nullable(text());
const version: Schema = { type: 'string', const: IntegrationContractVersion };
const provenance = values(['LOCAL', 'SUNAT_BETA', 'HISTORICAL']);
const moneyNames = ['lineExtensionAmount', 'taxableAmount', 'exemptAmount', 'unaffectedAmount', 'freeAmount', 'igvAmount', 'iscAmount', 'otherTaxesAmount', 'allowanceTotalAmount', 'chargeTotalAmount', 'prepaidAmount', 'payableAmount'];
const filterProperties = {
  issuerRuc: { type: 'string', pattern: IntegrationPatterns.ruc }, environment: { type: 'string', const: 'BETA', default: 'BETA' },
  dataset: { type: 'string', const: 'ISSUED_BUSINESS', default: 'ISSUED_BUSINESS' }, from: date, to: date,
  types: { ...array(values(IntegrationDocumentTypes), 6), minItems: 1, uniqueItems: true, default: [...IntegrationDocumentTypes] },
  branchId: uuid, pointId: uuid, series: { type: 'string', pattern: IntegrationPatterns.series }, currency: values(['PEN', 'USD']), fiscalStatus: values(IntegrationFiscalStates),
};
const resourceProperties = {
  issuerRuc: filterProperties.issuerRuc, environment: { type: 'string', const: 'BETA' }, dataset: { type: 'string', const: 'ISSUED_BUSINESS' },
  type: values(IntegrationDocumentTypes), branchId: nullable(uuid), pointId: nullable(uuid), seriesCounterId: nullable(uuid),
};
const rowProperties = {
  ...resourceProperties, schemaVersion: version, id: uuid, series: filterProperties.series, number: { type: 'string', pattern: IntegrationPatterns.number }, fullNumber: text(32),
  resourceVersion: text(100), observedAt: timestamp, snapshotSha256: nullable({ type: 'string', pattern: IntegrationPatterns.sha256 }),
  issuerName: ns, issueDate: date, issueTime: time, issuedAt: nullable(timestamp), currency: nullable(values(['PEN', 'USD'])),
  customer: nullable(ref('Party')), payableAmount: decimal, state: ref('DocumentState'), source: ref('DocumentSource'), warnings: array(text(120), 100),
};
const page = (item: string): Schema => object({ schemaVersion: version, items: array(ref(item), IntegrationLimits.maxPageSize), page: ref('PageInfo'), coverage: ref('Coverage') });
const schemaDefinitions: Record<string, Schema> = {
  Party: object({ identityType: nullable(text(4)), identityNumber: nullable(text(32)), legalName: nullable(text(500)), address: nullable(text(1000)), ubigeo: nullable({ type: 'string', pattern: '^[0-9]{6}$' }), establishmentCode: nullable(text(10)) }),
  Tax: object({ schemeId: ns, name: ns, taxableAmount: decimal, amount: decimal, percent: decimal, affectationCode: ns }),
  Allowance: object({ charge: { type: 'boolean' }, amount: decimal, baseAmount: decimal, percent: decimal, reasonCode: ns, reason: ns }),
  Item: object({ lineId: text(30), productCode: ns, description: text(2000), unitCode: ns, quantity: decimal, unitValue: decimal, unitPriceWithTax: decimal, lineExtensionAmount: decimal, taxes: array(ref('Tax'), 50), allowances: array(ref('Allowance'), 50) }),
  Totals: object(Object.fromEntries(moneyNames.map(k => [k, decimal]))),
  Reference: object({ documentId: nullable(uuid), type: nullable(values(IntegrationDocumentTypes)), fullNumber: text(100), kind: text(50), reasonCode: ns, reason: nullable(text(1000)) }),
  PaymentTerms: object({ type: nullable(values(['CONTADO', 'CREDITO'])), pendingAmount: decimal, installments: array(object({ amount: { type: 'string', pattern: IntegrationPatterns.decimal }, dueDate: date }), 999) }),
  Sale: object({ kind: { type: 'string', const: 'SALE' }, issuer: ref('Party'), customer: ref('Party'), operationTypeCode: ns, items: array(ref('Item')), taxes: array(ref('Tax'), 50), allowances: array(ref('Allowance'), 50), totals: ref('Totals'), paymentTerms: ref('PaymentTerms'), references: array(ref('Reference'), 100), observations: nullable(text(4000)), additionalInformation: array(object({ name: text(100), value: text(1000) }), 100) }),
  Guide: object({ kind: { type: 'string', const: 'GUIDE' }, issuer: ref('Party'), sender: nullable(ref('Party')), recipient: nullable(ref('Party')), carrier: nullable(ref('Party')), items: array(ref('Item')), reasonCode: ns, reason: ns, transferDate: nullable(date), origin: ref('Party'), destination: ref('Party'), grossWeight: decimal, weightUnit: ns, packageCount: nullable({ type: 'string', pattern: '^[0-9]{1,20}$' }), modeCode: ns, vehicles: array(object({ plate: text(30), authorization: ns }), 100), drivers: array(object({ identityType: ns, identityNumber: ns, firstNames: ns, lastNames: ns, license: ns }), 100), references: array(ref('Reference'), 100), observations: nullable(text(4000)) }),
  DocumentState: object({ local: nullable(values(['DRAFT', 'ISSUED', 'CANCELLED'])), fiscal: values(IntegrationFiscalStates), transport: nullable(values(IntegrationFiscalStates)), provenance, verifiedAt: nullable(timestamp), responseCode: nullable(text(30)) }),
  DocumentSource: object({ system: values(['BILLING', 'AUTHORIZED_HISTORY']), originSystem: nullable(text(40)), originId: nullable(text(120)) }),
  DocumentRow: object(rowProperties),
  DocumentDetail: { oneOf: [object({ ...rowProperties, type: values(['01', '03']), detail: ref('Sale') }), object({ ...rowProperties, type: values(['07', '08']), detail: { allOf: [ref('Sale'), { type: 'object', properties: { references: { type: 'array', minItems: 1 } } }] } }), object({ ...rowProperties, type: values(['09', '31']), detail: ref('Guide') })] },
  PageInfo: object({ limit: { type: 'integer', minimum: 1, maximum: IntegrationLimits.maxPageSize }, nextCursor: nullable({ type: 'string', pattern: IntegrationPatterns.opaque }), snapshotId: uuid, snapshotAt: timestamp, expiresAt: timestamp, hasMore: { type: 'boolean' }, changeCheckpoint: nullable({ type: 'string', pattern: IntegrationPatterns.opaque }) }),
  Coverage: object({ types: array(object({ type: values(IntegrationDocumentTypes), state: values(['READY', 'UNSUPPORTED', 'UNAVAILABLE']), reasonCode: ns }), 6), complete: { type: 'boolean' } }),
  DocumentPage: page('DocumentRow'),
  Verification: object({ integrity: values(['VERIFIED', 'UNVERIFIED', 'FAILED']), signature: values(['VERIFIED', 'UNVERIFIED', 'FAILED', 'NOT_APPLICABLE']), trust: values(['VERIFIED', 'UNVERIFIED', 'FAILED', 'NOT_APPLICABLE']), identity: values(['MATCHED', 'UNVERIFIED', 'MISMATCH']), checkedAt: nullable(timestamp) }),
  Artifact: object({ id: uuid, kind: values(IntegrationArtifactKinds), owner: object({ kind: values(['DOCUMENT', 'BATCH']), id: uuid }), fileName: { type: 'string', maxLength: 150, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$' }, mediaType: values(['application/xml', 'application/zip', 'application/pdf']), byteLength: nullable({ type: 'integer', minimum: 0 }), sha256: nullable({ type: 'string', pattern: IntegrationPatterns.sha256 }), availability: values(['AVAILABLE', 'MISSING', 'PENDING', 'NOT_SUPPORTED', 'INCONSISTENT']), representation: values(['ORIGINAL', 'CURRENT']), provenance, verification: ref('Verification'), rendererVersion: ns, profileRevision: ns, generatedAt: nullable(timestamp) }),
  ArtifactList: object({ schemaVersion: version, items: array(ref('Artifact'), 100), warnings: array(text(120), 100) }),
  Batch: object({ schemaVersion: version, id: uuid, issuerRuc: filterProperties.issuerRuc, environment: { type: 'string', const: 'BETA' }, kind: values(['RC', 'RA']), identifier: text(50), state: ref('DocumentState'), membersComplete: { type: 'boolean', const: true }, members: { ...array(object({ documentId: uuid, type: values(IntegrationDocumentTypes), fullNumber: text(32), conditionCode: ns, documentVersion: ns }), IntegrationLimits.maxBatchMembers), minItems: 1 } }),
  Issuer: object({ issuerRuc: filterProperties.issuerRuc, legalName: text(500), environment: { type: 'string', const: 'BETA' }, active: { type: 'boolean' } }),
  Branch: object({ id: uuid, issuerRuc: filterProperties.issuerRuc, code: text(30), name: text(300), active: { type: 'boolean' }, address: ns, establishmentCode: ns }),
  Point: object({ id: uuid, branchId: uuid, issuerRuc: filterProperties.issuerRuc, code: text(30), name: text(300), active: { type: 'boolean' }, series: array(object({ id: uuid, type: values(IntegrationDocumentTypes), label: filterProperties.series, active: { type: 'boolean' } }), 100) }),
  IssuerPage: page('Issuer'), BranchPage: page('Branch'), PointPage: page('Point'),
  Capabilities: object({ schemaVersion: version, environment: { type: 'string', const: 'BETA' }, dataset: { type: 'string', const: 'ISSUED_BUSINESS' }, apiState: values(['DISABLED', 'ENABLED']), types: array(object({ type: values(IntegrationDocumentTypes), readState: values(['READY', 'PREPARED_BLOCKED', 'LAB_ONLY', 'DIAGNOSTIC_ONLY', 'UNSUPPORTED']), originalArtifacts: { type: 'boolean' }, reasonCode: ns }), 6), consistency: values(['SNAPSHOT_READY', 'NOT_READY']), changes: values(['READY', 'NOT_READY']), limits: object(Object.fromEntries(Object.entries(IntegrationLimits).map(([k, v]) => [k, { type: 'integer', const: v }]))) }),
  Error: object({ schemaVersion: version, requestId: uuid, error: object({ code: values(IntegrationErrors), message: text(300), retryable: { type: 'boolean' } }) }),
  ExportFilters: object(filterProperties, ['environment', 'dataset', 'types', 'branchId', 'pointId', 'series', 'currency', 'fiscalStatus']),
  ExportRequest: object({ filters: ref('ExportFilters'), artifactKinds: { ...array(values(IntegrationArtifactKinds), 8), uniqueItems: true }, missingArtifacts: values(['FAIL', 'REPORT']), dataFormat: { type: 'string', const: 'JSONL' } }),
  ExportJob: object({ schemaVersion: version, id: uuid, state: values(['QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED']), createdAt: timestamp, expiresAt: nullable(timestamp), snapshotId: nullable(uuid), snapshotAt: nullable(timestamp), changeCheckpoint: nullable({ type: 'string', pattern: IntegrationPatterns.opaque }), documentCount: nullable({ type: 'integer', minimum: 0 }), complete: { type: 'boolean' }, failureCode: nullable(values(IntegrationErrors)), manifestSha256: nullable({ type: 'string', pattern: IntegrationPatterns.sha256 }) }),
  ExportManifest: object({ schemaVersion: { type: 'string', const: 'factuez.integration.export-manifest.v1' }, exportId: uuid,
    environment: { type: 'string', const: 'BETA' }, dataset: { type: 'string', const: 'ISSUED_BUSINESS' }, filters: ref('ExportFilters'), snapshotId: uuid, snapshotAt: timestamp,
    changeCheckpoint: nullable({ type: 'string', pattern: IntegrationPatterns.opaque }), createdAt: timestamp, expiresAt: timestamp, documentCount: { type: 'integer', minimum: 0 },
    requestedArtifactKinds: { ...array(values(IntegrationArtifactKinds), 8), uniqueItems: true }, missingArtifactsPolicy: values(['FAIL', 'REPORT']), complete: { type: 'boolean' }, coverage: ref('Coverage'),
    files: array(object({ path: { type: 'string', pattern: '^(?:documents\\.jsonl|artifacts/' + IntegrationPatterns.uuid.slice(1, -1) + '\\.(?:xml|zip|pdf))$' }, sha256: { type: 'string', pattern: IntegrationPatterns.sha256 },
      byteLength: { type: 'integer', minimum: 0 }, artifactId: nullable(uuid), owner: nullable(object({ kind: values(['DOCUMENT', 'BATCH']), id: uuid })), documentIds: array(uuid) }), 100000),
    missingArtifacts: array(object({ documentId: uuid, kind: values(IntegrationArtifactKinds), code: values(['ARTIFACT_UNAVAILABLE', 'SOURCE_NOT_SUPPORTED', 'INTEGRITY_FAILED', 'INCOMPLETE_BINDING']) }), 100000),
  }),
  Change: object({ eventId: uuid, documentId: uuid, type: values(IntegrationDocumentTypes), issuerRuc: filterProperties.issuerRuc, environment: { type: 'string', const: 'BETA' }, sequence: { type: 'string', pattern: '^[0-9]{1,26}$' }, kind: values(['DOCUMENT_CREATED', 'DOCUMENT_STATE_CHANGED', 'ARTIFACT_ADDED', 'DOCUMENT_RECONCILED']), occurredAt: timestamp, version: text(100), resource: object(resourceProperties) }),
  ChangePage: object({ schemaVersion: version, items: array(ref('Change'), IntegrationLimits.maxPageSize), nextCheckpoint: { type: 'string', pattern: IntegrationPatterns.opaque }, hasMore: { type: 'boolean' }, expiresAt: timestamp }),
  TokenRequest: object({ grant_type: { type: 'string', const: 'client_credentials' }, scope: { type: 'string', minLength: 1, maxLength: 500, description: 'Scopes de IntegrationScopes separados por un espacio, sin duplicados. No acepta permisos humanos/SUNAT.' } }),
  Token: object({ access_token: text(8192), token_type: { type: 'string', const: 'Bearer' }, expires_in: { type: 'integer', minimum: 1, maximum: IntegrationLimits.tokenMaxTtlSeconds }, scope: text(500) }),
  OAuthError: object({ error: values(['invalid_request', 'invalid_client', 'invalid_scope', 'unsupported_grant_type', 'temporarily_unavailable']) }),
};
const parameter = (name: string, schema: Schema, required = false, description?: string): Schema => ({ name, in: 'query', required, schema, ...(description ? { description } : {}), ...(name === 'types' ? { style: 'form', explode: false } : {}) });
const pathParameter = (name: string): Schema => ({ name, in: 'path', required: true, schema: uuid });
const commonHeaders: Record<string, unknown> = {
  'Cache-Control': { schema: { type: 'string', const: 'private, no-store' }, description: 'No caché de proxy/navegador. Caché interna privada siempre reautoriza.' },
  'X-Request-Id': { schema: uuid },
};
const response = (schemaName: string, description = 'Respuesta autorizada'): Schema => ({ description, headers: commonHeaders, content: { 'application/json': { schema: ref(schemaName) } } });
const errorStatuses = ['400', '401', '403', '404', '409', '410', '422', '429', '503'];
const errorResponses = Object.fromEntries(errorStatuses.map(status => ['Error' + status, {
  ...response('Error', `Error ${status}; sin datos de recursos ajenos ni rutas internas.`),
  headers: { ...commonHeaders, ...(status === '401' || status === '403' ? { 'WWW-Authenticate': { schema: text(300) } } : {}), ...(status === '429' || status === '503' ? { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } } : {}) },
}]));
const errors = Object.fromEntries(errorStatuses.map(status => [status, { $ref: `#/components/responses/Error${status}` }]));
const operation = (id: string, summary: string, schemaName: string, scopes: IntegrationScopeList, phase: number, parameters: Schema[] = []): Schema => ({ operationId: id, summary, tags: [phase === 3 ? 'Identidad' : phase === 5 ? 'Exportaciones' : phase === 6 ? 'Cambios' : 'Lectura'], 'x-implementation-phase': phase, 'x-implemented': false, security: [{ IntegrationOAuth: scopes }], parameters, responses: { '200': response(schemaName), ...errors } });
type IntegrationScopeList = typeof IntegrationScopes[number][];
const documents: IntegrationScopeList = ['integration:documents:read'];
const artifacts: IntegrationScopeList = [...documents, 'integration:artifacts:read'];
const catalog: IntegrationScopeList = ['integration:catalog:read'];
const issuer = parameter('issuerRuc', filterProperties.issuerRuc, true, 'Un RUC autorizado por petición; no comodines.');
const beta = parameter('environment', filterProperties.environment);
const limit = parameter('limit', { type: 'integer', minimum: 1, maximum: IntegrationLimits.maxPageSize, default: IntegrationLimits.defaultPageSize });
const cursor = parameter('cursor', { type: 'string', pattern: IntegrationPatterns.opaque }, false, 'Token opaco autenticado ligado a cliente, grants, filtros y corte; no offset ni timestamp arbitrario.');
const artifactContent = (id: string, scopes: IntegrationScopeList, phase: number, params: Schema[]): Schema => ({
  ...operation(id, 'Descargar bytes íntegros, previa reautorización e integridad', 'Artifact', scopes, phase, params),
  responses: { '200': { description: 'Bytes completos. No redirección pública; no base64 ni sustitución silenciosa.', headers: { ...commonHeaders, 'Content-Disposition': { schema: text(300) }, 'Content-Length': { schema: { type: 'integer', minimum: 0 } }, 'X-Content-SHA256': { schema: { type: 'string', pattern: IntegrationPatterns.sha256 } }, 'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } } }, content: { 'application/xml': {}, 'application/zip': {}, 'application/pdf': {} } }, ...errors },
});
/** Serializable source of truth; checked-in JSON snapshot must equal this object. No URL is operational. */
export function integrationOpenApiV1(): Record<string, unknown> {
  const exportCreate = operation('createExport', 'Preparar exportación temporal de lectura; no emite comprobantes', 'ExportJob', [...documents, 'integration:exports:create'], 5);
  exportCreate.parameters = [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' } }];
  exportCreate.requestBody = { required: true, content: { 'application/json': { schema: ref('ExportRequest') } } };
  exportCreate.responses = { '202': response('ExportJob', 'Trabajo aceptado, no exportación finalizada'), ...errors };
  exportCreate['x-conditional-scopes'] = { nonEmptyArtifactKinds: ['integration:artifacts:read'] };
  const jobParams = [pathParameter('exportId'), issuer, beta];
  const exportRead = operation('getExport', 'Consultar trabajo sólo del cliente creador', 'ExportJob', [...documents, 'integration:exports:read'], 5, jobParams);
  exportRead['x-conditional-scopes'] = { jobContainsArtifacts: ['integration:artifacts:read'] };
  const exportManifest = operation('getExportManifest', 'Consultar manifiesto del trabajo antes de descargar el paquete', 'ExportManifest', [...documents, 'integration:exports:read'], 5, jobParams);
  exportManifest['x-conditional-scopes'] = { jobContainsArtifacts: ['integration:artifacts:read'] };
  const exportContent = artifactContent('downloadExport', [...documents, 'integration:exports:read'], 5, jobParams);
  exportContent['x-conditional-scopes'] = { jobContainsArtifacts: ['integration:artifacts:read'] };
  (exportContent.responses as Record<string, Schema>)['200'].content = { 'application/zip': {} };
  return {
    openapi: '3.1.1', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'FactuEz · API privada de extracción', version: '1.0.0', description: 'Contrato de fase 2, NO IMPLEMENTADO. Sólo lectura de emitidos BUSINESS en BETA. Acceso remoto privado pendiente de fase 7. Host .invalid de ejemplo; sin configuración SUNAT ni producción.' },
    servers: [{ url: 'https://factuez.invalid', description: 'Ejemplo no resoluble; TI sustituirá por DNS privado HTTPS dentro de VPN.' }],
    'x-contract-version': IntegrationContractVersion, 'x-delivery-state': 'CONTRACT_ONLY', 'x-environment': 'BETA',
    'x-access-design': { network: 'PRIVATE_VPN_AND_HTTPS', tokenAudience: 'factuez-integration-v1', humanSessionsAccepted: false, grants: 'TUPLES_RUC_BRANCH_POINT_SERIES_TYPE', dataDomain: 'ISSUED_BUSINESS' },
    security: [{ IntegrationOAuth: documents }],
    tags: ['Identidad', 'Lectura', 'Exportaciones', 'Cambios'].map(name => ({ name })),
    paths: {
      '/integration/oauth/token': { post: { operationId: 'createIntegrationToken', summary: 'Identidad M2M independiente; no usuario SOL ni cuenta de caja', tags: ['Identidad'], 'x-implementation-phase': 3, 'x-implemented': false, security: [{ IntegrationClientBasic: [] }], requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: ref('TokenRequest') } } }, responses: { '200': response('Token', 'Token corto, sin refresh token'), '400': response('OAuthError'), '401': { ...response('OAuthError'), headers: { ...commonHeaders, 'WWW-Authenticate': { schema: { type: 'string', const: 'Basic' } } } }, '429': response('OAuthError'), '503': response('OAuthError') } } },
      '/integration/v1/capabilities': { get: operation('getCapabilities', 'Cobertura real para el cliente y RUC; no promesas por existencia de enum', 'Capabilities', catalog, 4, [issuer, beta]) },
      '/integration/v1/issuers': { get: operation('listIssuers', 'Sólo emisores autorizados, incluidos inactivos históricos', 'IssuerPage', catalog, 4, [beta, limit, cursor]) },
      '/integration/v1/branches': { get: operation('listBranches', 'Sólo sedes autorizadas para el RUC', 'BranchPage', catalog, 4, [issuer, beta, limit, cursor]) },
      '/integration/v1/points': { get: operation('listPoints', 'Puntos y series autorizados; no contadores ni permisos de edición', 'PointPage', catalog, 4, [issuer, beta, parameter('branchId', uuid, true), limit, cursor]) },
      '/integration/v1/documents': { get: operation('listDocuments', 'Listado estable al corte; cobertura explícita por tipo', 'DocumentPage', documents, 5, [...Object.entries(filterProperties).map(([name, schema]) => parameter(name, schema, ['issuerRuc', 'from', 'to'].includes(name))), limit, cursor]) },
      '/integration/v1/documents/lookup': { get: operation('lookupDocument', 'Consulta exacta por RUC, ambiente, tipo, serie y número; sin periodo obligatorio', 'DocumentDetail', documents, 4, [issuer, beta, parameter('type', values(IntegrationDocumentTypes), true), parameter('series', filterProperties.series, true), parameter('number', { type: 'string', pattern: IntegrationPatterns.number }, true)]) },
      '/integration/v1/documents/{documentId}': { get: operation('getDocument', 'Cabecera, cliente, ítems, impuestos, totales o traslado congelados', 'DocumentDetail', documents, 4, [pathParameter('documentId'), issuer, beta, parameter('snapshotId', uuid, false, 'Consulta en el corte vigente; sin este campo devuelve versión actual con estados a ese instante.')]) },
      '/integration/v1/documents/{documentId}/artifacts': { get: operation('listDocumentArtifacts', 'Inventario autorizado; CDR de lote sólo si todos sus miembros son visibles', 'ArtifactList', artifacts, 4, [pathParameter('documentId'), issuer, beta]) },
      '/integration/v1/batches/{batchId}': { get: operation('getBatch', 'RC/RA con pertenencia íntegra autorizada; nunca revela miembros fuera del scope', 'Batch', documents, 4, [pathParameter('batchId'), issuer, beta]) },
      '/integration/v1/batches/{batchId}/artifacts': { get: operation('listBatchArtifacts', 'Inventario de originales de lote tras autorización completa', 'ArtifactList', artifacts, 4, [pathParameter('batchId'), issuer, beta]) },
      '/integration/v1/artifacts/{artifactId}/content': { get: artifactContent('downloadArtifact', artifacts, 4, [pathParameter('artifactId'), issuer, beta]) },
      '/integration/v1/exports': { post: exportCreate },
      '/integration/v1/exports/{exportId}': { get: exportRead },
      '/integration/v1/exports/{exportId}/manifest': { get: exportManifest },
      '/integration/v1/exports/{exportId}/content': { get: exportContent },
      '/integration/v1/changes': { get: operation('listChanges', 'Feed durable al menos una vez; checkpoint ligado a cliente y permisos', 'ChangePage', [...documents, 'integration:changes:read'], 6, [issuer, beta, parameter('checkpoint', { type: 'string', pattern: IntegrationPatterns.opaque }, true), limit]) },
    },
    components: {
      securitySchemes: {
        IntegrationOAuth: { type: 'oauth2', description: 'Confidential client, no sesión PWA. Bearer sólo en Authorization sobre HTTPS. Issuer/audience/algoritmo/tipo y revocación se verifican en fase 3.', flows: { clientCredentials: { tokenUrl: 'https://factuez.invalid/integration/oauth/token', scopes: Object.fromEntries(IntegrationScopes.map(scope => [scope, scope])) } } },
        IntegrationClientBasic: { type: 'http', scheme: 'basic', description: 'ID/secreto propios de integración, exclusivamente para token endpoint sobre HTTPS/VPN. Nunca SOL, P12 ni secretos SUNAT.' },
      },
      schemas: schemaDefinitions, responses: errorResponses,
    },
  };
}

/** Current documentation view. Never changes the frozen phase-2 contract or activates a listener. */
export function integrationSwaggerV1(): Record<string, unknown> {
  const api = integrationOpenApiV1();
  // The UI supports the OAS base dialect, which includes all keywords used here.
  // Preserve the historical contract's explicit 2020-12 dialect unchanged.
  api.jsonSchemaDialect = 'https://spec.openapis.org/oas/3.1/dialect/base';
  api.info = {
    title: 'FactuEz · Extracción privada ERP', version: '1.0.0',
    description: 'Código implementado y ensayado de forma aislada (fases 3–8), con activación privada pendiente de TI. Este visor NO habilita la API en el stack de la PWA ni prueba disponibilidad. Perfil ISSUED_BUSINESS / BETA: lectura 01, 03, 07 y 08 cuando existen documentos y archivos coherentes. 09 y 31 continúan SOURCE_NOT_SUPPORTED en este lector. No incluye compras recibidas, SOL, P12 ni producción. La cobertura efectiva se consulta en capabilities del despliegue autorizado. Host .invalid deliberadamente no operativo. Swagger se ofrece sólo como referencia, sin ejecutar peticiones.',
  };
  api['x-delivery-state'] = 'IMPLEMENTED_OPT_IN_ACTIVATION_PENDING';
  api['x-runtime-status'] = 'NOT_PROBED_BY_DOCUMENTATION';
  for (const methods of Object.values(api.paths as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const operation of Object.values(methods)) {
      operation['x-implemented'] = true;
      operation['x-activation-required'] = true;
    }
  }
  const securitySchemes = (api.components as { securitySchemes: Record<string, Record<string, unknown>> }).securitySchemes;
  securitySchemes.IntegrationOAuth.description = 'Cliente confidencial ERP: client_credentials mediante HTTP Basic en el token endpoint y Bearer para datos. Token máximo 300 s; sin refresh token. Nunca cuenta PWA, SOL, certificado fiscal ni secreto GRE. Requiere HTTPS/VPN y grants vigentes por RUC–sede–punto–serie–tipo. TI define los certificados TLS/mTLS de transporte del despliegue; son distintos del P12 fiscal.';
  return api;
}
