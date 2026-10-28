import { PermissionCodes, RoleCodes } from '@factuez/contracts';

/** Native human-facing controllers only: no owner RPCs, admission or QA. */
type Schema = Record<string, unknown>;
type Parameter = { name: string; in: string; required: boolean; schema: Schema; description?: string };
type Response = { description: string; content?: Record<string, { schema: Schema }>; headers?: Record<string, unknown> };
type Operation = {
  operationId: string; summary: string; description: string; tags: string[];
  security: Record<string, string[]>[]; parameters: Parameter[]; responses: Record<string, Response>;
  requestBody?: { required: boolean; content: Record<string, { schema: Schema }> };
};
const str = (maxLength?: number): Schema => ({ type: 'string', ...(maxLength === undefined ? {} : { maxLength }) });
const integer = (minimum = 0, maximum?: number): Schema => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) });
const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values });
const uuid: Schema = { type: 'string', format: 'uuid' };
const dateTime: Schema = { type: 'string', format: 'date-time' }, date: Schema = { type: 'string', format: 'date' }, bool: Schema = { type: 'boolean' };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: Schema, minItems?: number, maxItems?: number): Schema => ({ type: 'array', items,
  ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }) });
const object = (properties: Record<string, Schema>, required = Object.keys(properties), closed = true): Schema => ({
  type: 'object', properties, required, ...(closed ? { additionalProperties: false } : {}),
});
const query = (name: string, schema: Schema, description?: string): Parameter => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const path = (name = 'id', schema = uuid): Parameter => ({ name, in: 'path', required: true, schema });
const header = (name: string, schema: Schema, required = true): Parameter => ({ name, in: 'header', required, schema });
const json = (description: string, schema: Schema): Response => ({ description, content: { 'application/json': { schema } } });
const error = object({ statusCode: integer(), message: { oneOf: [str(), array(str())] }, error: str() }, ['message'], false);
const bearer = [{ HumanSessionBearer: [] }], cookie = [{ NativeBrowserSessionCookie: [] }];
const revision = integer(1), companyId = integer(1, 2147483647);
const ruc: Schema = { type: 'string', pattern: '^\\d{11}$' }, decimal: Schema = { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,6})?$' };
const money: Schema = { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,2})?$' };
const roles = enumeration(...Object.values(RoleCodes));
const permissions = { ...array(enumeration(...Object.values(PermissionCodes)), 0, Object.keys(PermissionCodes).length), uniqueItems: true };
const extraPermissions = { ...array(enumeration('document.view', 'document.issue', 'document.email', 'report.view', 'report.export', 'audit.view', 'shift.open', 'shift.close'), 0, 8), uniqueItems: true };
const ids = array(uuid, 0, 100), seriesIds = { ...array(uuid, 0, 200), description: 'UUID en minúsculas de SeriesCounter; no etiquetas F001/B001.' };
const scope = { oneOf: [object({ kind: { const: 'GLOBAL' } }), object({ kind: { const: 'ASSIGNED' }, branchIds: array(uuid), emissionPointIds: array(uuid), series: array(uuid) })] };
const claims = object({ sub: uuid, username: str(), fullName: str(), roles: array(roles), permissions, scope, authVersion: integer(),
  browserSessionId: str(), emissionPointIds: array(uuid), iss: str(), aud: { oneOf: [str(), array(str())] }, exp: integer(), iat: integer() },
  ['sub', 'username', 'roles', 'permissions', 'scope', 'authVersion', 'iss', 'aud', 'exp', 'iat'], false);
const access = { accessToken: str(), tokenType: { const: 'Bearer' }, expiresIn: integer(1) };
const sessionTiming = { idleExpiresAt: integer(), idleTimeoutSeconds: { type: 'integer', const: 1800 }, serverNow: integer() };
const sessionResponse = object({ ...access, user: claims, ...sessionTiming });
const login = object({ username: { ...str(80), minLength: 1 }, password: { ...str(256), minLength: 1, format: 'password', writeOnly: true } }, undefined, false);
const statusDescriptions: Record<number, string> = {
  400: 'Campos, formato, filtros o identificadores inválidos', 401: 'Identidad ausente, inválida, revocada o vencida',
  403: 'Permiso, alcance, origen o perfil no autorizado', 404: 'Recurso no disponible en el alcance actual',
  409: 'Revisión concurrente, duplicado incompatible o estado no modificable', 503: 'Servicio o requisito local no disponible',
};
function operation(id: string, summary: string, tag: string, permission: string, parameters: Parameter[], success: number,
  result: Schema, input?: Schema, description = '', failures: number[] = [400, 401, 403, 503]): Operation {
  return { operationId: 'native' + id, summary, tags: [tag], description: (permission ? 'Requiere ' + permission + '. ' : '') + description,
    parameters, security: bearer, responses: { [success]: json(success === 202 ? 'Registro encolado; no equivale a aceptación SUNAT' : 'Resultado de la operación', result),
      ...Object.fromEntries(failures.map(status => [status, json(statusDescriptions[status], error)])) },
    ...(input === undefined ? {} : { requestBody: { required: true, content: { 'application/json': { schema: input } } } }),
  };
}
function binary(op: Operation, media: string[]): Operation {
  const success = Object.keys(op.responses).find(code => Number(code) < 300)!;
  return { ...op, responses: { ...op.responses, [success]: { description: 'Archivo privado; no-store',
    content: Object.fromEntries(media.map(type => [type, { schema: { type: 'string', format: 'binary' } }])),
    headers: { 'Cache-Control': { schema: str() }, 'Content-Disposition': { schema: str() } },
  } } };
}
export function nativeRuntimeOpenApiSecuritySchemes() {
  return { NativeBrowserSessionCookie: { type: 'apiKey', in: 'cookie', name: 'factuez_session',
    description: 'Cookie opaca HttpOnly; SameSite=Strict; Secure salvo QA local. Path=/api/v1/auth/browser-session. Inactividad máxima 1800 segundos.' } };
}

export function nativeRuntimeOpenApiPaths() {
  const issuerFields = { legalName: { ...str(200), minLength: 1 }, taxAddress: { ...str(300), minLength: 1 },
    ubigeo: { type: 'string', pattern: '^\\d{6}$' }, tradeName: nullable(str(200)), phone: nullable(str(40)),
    contactEmails: array({ type: 'string', format: 'email', maxLength: 254 }, 0, 10) };
  const issuer = object({ id: companyId, ruc, ...issuerFields, active: bool, environment: enumeration('BETA', 'PRODUCTION'), revision });
  const masterFields = { code: { ...str(20), pattern: '^[A-Za-z0-9_-]{2,20}$', description: 'Se normaliza a mayúsculas.' },
    name: { ...str(120), minLength: 1 }, address: nullable(str(300)) };
  const establishmentCode = nullable({ type: 'string', pattern: '^\\d{4}$', description: 'Establecimiento SUNAT; no es el código del punto.' });
  const trackNumber = nullable(integer(1, 9999));
  const branch = object({ id: uuid, companyId, ...masterFields, establishmentCode, active: bool, revision }, undefined, false);
  const point = object({ id: uuid, companyId, branchId: nullable(uuid), ...masterFields, trackNumber, active: bool, revision },
    ['id', 'companyId', 'branchId', 'code', 'name', 'active', 'revision'], false);
  const seriesType = enumeration('INVOICE', 'SALES_RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE', 'DESPATCH_ADVICE');
  const seriesName = { type: 'string', pattern: '^[FBTfbt][A-Za-z0-9]{3}$',
    description: 'INVOICE (01): Fxxx; SALES_RECEIPT (03): Bxxx; CREDIT_NOTE (07)/DEBIT_NOTE (08): Fxxx o Bxxx; DESPATCH_ADVICE (09): Txxx. Se normaliza a mayúsculas. Crear la serie no habilita emisión de todos esos tipos.' };
  const series = object({ id: uuid, companyId, emissionPointId: uuid, documentType: seriesType, series: seriesName,
    nextNumber: { type: 'string', pattern: '^\\d+$', readOnly: true }, active: bool, revision }, undefined, false);
  const catalog = object({ version: str(), capabilities: object({ betaOnly: bool, softDelete: { const: true }, counterEditing: { const: false } }),
    companies: array(issuer), branches: array({ ...branch, properties: { ...(branch.properties as Record<string, Schema>), effectiveActive: bool, pointCount: integer(), openShiftCount: integer() } }),
    emissionPoints: array({ ...point, properties: { ...(point.properties as Record<string, Schema>), effectiveActive: bool, openShiftCount: integer() } }),
    series: array({ ...series, properties: { ...(series.properties as Record<string, Schema>), effectiveActive: bool, documentCount: integer(), canRename: bool } }) });
  const masterDescription = 'Administrador general de alcance GLOBAL. Requiere CRUD habilitado. Producción exige habilitación de emisión y sesión humana. Las bajas son lógicas; los turnos abiertos impiden desactivar. No modifica documentos emitidos ni reinicia correlativos.';
  const master = (id: string, title: string, permission: string, params: Parameter[], success: number, result: Schema, input?: Schema, detail = '') =>
    operation(id, title, 'Emisores, sedes y series', permission, params, success, result, input, masterDescription + ' ' + detail, [400, 401, 403, 404, 409, 503]);
  const productFields = { sku: { ...str(40), minLength: 1 }, description: { ...str(250), minLength: 1 }, category: { ...str(80), minLength: 1 },
    sunatProductCode: nullable({ type: 'string', pattern: '^\\d{8}$' }), unitCode: { type: 'string', pattern: '^(?:[A-Z0-9]{3}|ZZ|M3)$' },
    taxAffectationCode: enumeration('10', '11', '12', '13', '14', '15', '16', '17', '20', '21', '30', '31', '32', '33', '34', '35', '36', '37', '40'),
    defaultUnitPrice: nullable(decimal), active: bool };
  const product = object({ id: uuid, ...productFields, updatedAt: dateTime });
  const productOp = (id: string, title: string, params: Parameter[], success: number, result: Schema, input?: Schema) =>
    operation(id, title, 'Productos', 'product.manage y ADMIN GLOBAL', params, success, result, input,
      'Catálogo compartido. Cambiar el producto no cambia documentos históricos. Las afectaciones del catálogo son más amplias que el perfil de emisión 01/03.', [400, 401, 403, 404, 409, 503]);
  const userFields = { active: bool, roles: array(roles, 1), branchIds: ids, emissionPointIds: ids, series: seriesIds };
  const user = object({ id: uuid, username: str(), fullName: str(), active: bool, lastLoginAt: nullable(dateTime), roles: array(object({ code: roles, name: str() })),
    branchIds: ids, emissionPointIds: ids, series: seriesIds, editable: bool }, ['id', 'username', 'fullName', 'active', 'lastLoginAt', 'roles', 'branchIds', 'emissionPointIds', 'series']);
  const role = object({ id: uuid, code: roles, name: str(), description: nullable(str()), active: bool, permissions, editable: bool, assignable: bool },
    ['id', 'code', 'name', 'description', 'permissions', 'editable', 'assignable'], false);
  const extra = object({ userId: uuid, storageReady: bool, permissions: extraPermissions, expectedAuthVersion: integer(), available: extraPermissions, editable: bool });
  const identityOp = (id: string, title: string, permission: string, params: Parameter[], success: number, result: Schema, input?: Schema, description = '') =>
    operation(id, title, 'Usuarios y roles', permission, params, success, result, input, description, [400, 401, 403, 404, 409, 503]);
  const printSettings = object({ template: { const: 'SAN_JOSE_V1' }, logoMode: enumeration('DEFAULT', 'CUSTOM', 'NONE'), logoWidthMm: integer(20, 60),
    logoAlignment: enumeration('LEFT', 'CENTER'), showBranchAddress: bool, footerNote: { ...str(160), description: 'Texto comercial sin controles, marcas bidi ni <>.' } });
  const logoUpload = object({ mediaType: enumeration('image/png', 'image/jpeg', 'image/webp'), base64: { ...str(349528), contentEncoding: 'base64', writeOnly: true,
    description: 'Imagen estática hasta 256 KiB, 8–4096 px por lado y hasta 4.194.304 píxeles. Se normaliza a PNG; sin SVG, rutas ni URLs.' } });
  const draftFields = { settings: nullable(printSettings), logoUpload }, draft = object(draftFields, ['settings']);
  const printResult = object({ version: { const: 'factuez.print-settings.v1' }, companyId, ruc, branchId: nullable(uuid), revision: integer(), updatedAt: nullable(dateTime),
    override: nullable(printSettings), effective: printSettings, source: enumeration('BRANCH', 'ISSUER', 'DEFAULT'), logoPreviewDataUrl: nullable(str()), storageReady: bool, fiscalTransmission: { const: false } });
  const frozenLogo = object({ mediaType: { const: 'image/png' }, base64: str(), sha256: str(), width: integer(1), height: integer(1) });
  const printSnapshot = object({ version: { const: 'factuez.print-presentation.v1' }, issuerRuc: ruc, branchId: nullable(uuid), profileRevision: integer(), settings: printSettings,
    logo: nullable(frozenLogo), branchName: str(), branchAddress: str() }, ['version', 'issuerRuc', 'branchId', 'profileRevision', 'settings', 'logo']);
  const printParams = [path('companyId', companyId), query('branchId', uuid, 'Omitir para configurar el emisor; informar para la sede.')];
  const printing = (id: string, title: string, success: number, result: Schema, input?: Schema) => operation(id, title, 'Formatos y logos', 'setup.manage y ADMIN GLOBAL',
    printParams, success, result, input, 'Sólo BETA, con almacenamiento de impresión habilitado. settings=null restaura herencia; logoUpload sólo con logoMode=CUSTOM. La vista previa no emite ni transmite.', [400, 401, 403, 409, 503]);
  const line = object({ productId: uuid, productCode: str(), description: { ...str(250), minLength: 1 }, unitCode: { type: 'string', pattern: '^[A-Z0-9]{2,3}$' },
    quantity: { ...decimal, description: 'Decimal positivo > 0, hasta 12 enteros y 6 decimales.' }, unitPriceWithTax: { ...decimal, description: 'Precio positivo con IGV incluido.' },
    taxAffectationCode: { type: 'string', const: '10' }, igvRate: { type: 'string', const: '18' } },
    ['description', 'unitCode', 'quantity', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate']);
  const installment = object({ amount: { ...money, description: 'Positivo; suma de cuotas igual a pendingAmount.' }, dueDate: date, currencyCode: enumeration('PEN', 'USD') }, ['amount', 'dueDate']);
  const paymentTerms = { oneOf: [object({ type: { const: 'CONTADO' } }), object({ type: { const: 'CREDITO' }, currencyCode: enumeration('PEN', 'USD'), pendingAmount: money,
    installments: array(installment, 1, 999) })], description: 'Factura 01 real requiere forma de pago. Crédito sólo en factura, moneda coincidente y fechas/importe validados por el perfil fiscal.' };
  const totals = object({ taxableAmount: str(), igvAmount: str(), payableAmount: str() });
  const calculatedLine = object({ ...(line.properties as Record<string, Schema>), lineNumber: integer(1), unitValue: str(), lineExtensionAmount: str(), igvAmount: str(), totalAmount: str() },
    ['lineNumber', 'description', 'unitCode', 'quantity', 'unitValue', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate', 'lineExtensionAmount', 'igvAmount', 'totalAmount']);
  // Preview calls the calculator directly; issuance applies the stricter fiscal profile.
  const previewLine = object({ productId: uuid, productCode: str(), description: str(), unitCode: str(), quantity: str(), unitPriceWithTax: str(), taxAffectationCode: str(), igvRate: str() },
    ['description', 'unitCode', 'quantity', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate'], false);
  const calculated = object({ lines: array({ ...calculatedLine, properties: { ...(calculatedLine.properties as Record<string, Schema>), taxAffectationCode: str(), igvRate: str() } }), totals });
  const customer = object({ identityType: str(), identityNumber: str(), legalName: { ...str(200), minLength: 1 }, address: str(), email: str() },
    ['identityType', 'identityNumber', 'legalName']);
  const issueInput = object({ emissionPointId: uuid, shiftId: uuid, documentType: enumeration('INVOICE', 'SALES_RECEIPT'), series: { type: 'string', pattern: '^[FB][A-Z0-9]{3}$' },
    issueDate: { ...str(), description: 'Fecha parseable; omitida usa fecha actual.' }, currencyCode: { ...enumeration('PEN', 'USD'), default: 'PEN' }, paymentTerms, customer, lines: array(line, 1, 100) },
    ['emissionPointId', 'documentType', 'series', 'customer', 'lines']);
  const issueResult = object({ documentId: uuid, companyId, issuerRuc: ruc, fullNumber: str(), sunatStatus: str() });
  const snapshot = object({ companyId, branchId: uuid, environment: enumeration('BETA', 'PRODUCTION'), documentId: uuid, documentTypeCode: enumeration('01', '03', '07', '08', '09'),
    series: str(), number: str(), fullNumber: str(), issueDate: str(), currencyCode: enumeration('PEN', 'USD'), operationTypeCode: str(),
    issuer: object({ identityType: str(), identityNumber: str(), legalName: str(), address: str(), tradeName: str(), ubigeo: str(), establishmentCode: str() },
      ['identityType', 'identityNumber', 'legalName', 'ubigeo', 'establishmentCode'], false), customer: { ...customer, additionalProperties: true },
    lines: array({ ...calculatedLine, additionalProperties: true }), totals, paymentTerms, printPresentation: printSnapshot },
    ['documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'issueDate', 'currencyCode', 'operationTypeCode', 'issuer', 'customer', 'lines', 'totals'], false);
  const source = enumeration('BUSINESS', 'SYNTHETIC', 'ALL');
  const documentFilters = [query('branchId', uuid), query('companyId', companyId), query('dataSource', source, 'Omitida incluye todas las fuentes; no cambia el ambiente fiscal.')];
  const documentRow = object({ id: uuid, companyId, issuerRuc: ruc, fullNumber: str(), documentType: str(), customerLegalName: str(), payableAmount: str(), currencyCode: str(),
    sunatStatus: str(), issueDate: dateTime, branchName: str(), sunatResponseDescription: nullable(str()) });
  const docs = (id: string, title: string, permission: string, params: Parameter[], success: number, result: Schema, input?: Schema, description = '') =>
    operation(id, title, 'Emisión y consulta', permission, params, success, result, input, description, [400, 401, 403, 404, 409, 503]);
  const origin = header('Origin', { type: 'string', format: 'uri', description: 'Origen exacto permitido por AUTH_BROWSER_ORIGINS; HTTPS salvo QA local explícito.' });
  const browser = (id: string, title: string, params: Parameter[], result: Schema, input?: Schema, description = '', publicAccess = false, optionalCookie = false) => {
    const op = operation(id, title, 'Login y sesión', '', params, 200, result, input, description, [400, 401, 403, 503]);
    op.security = publicAccess ? [] : optionalCookie ? [{}, ...cookie] : cookie;
    op.responses['200'].headers = { 'Set-Cookie': { description: 'factuez_session; HttpOnly; SameSite=Strict; Path=/api/v1/auth/browser-session; Secure salvo QA local.', schema: str() },
      'Cache-Control': { schema: { type: 'string', const: 'no-store, private' } } };
    return op;
  };
  const receivedBase = '/api/v1/received-documents';
  const receivedRow = object({ id: uuid, companyId, recipientRuc: ruc, branchId: nullable(uuid), supplierRuc: ruc, supplierName: nullable(str()), documentType: str(), fullNumber: str(),
    issueDate: date, currencyCode: nullable(str()), payableAmount: nullable(str()), receivedAt: dateTime, itemCount: integer(), sunatStatus: { const: 'NOT_CHECKED' },
    lastVerifiedAt: { type: 'null' }, registeredAt: nullable(dateTime), erpReference: nullable(str()), warnings: array(str()) });
  const receivedArtifact = object({ id: uuid, kind: enumeration('XML', 'PROVIDER_PDF', 'CDR'), fileName: str(), sha256: str(), byteLength: integer() });
  const receivedParty = object({ identityNumber: nullable(str()), identityType: nullable(str()), legalName: nullable(str()), address: nullable(str()) });
  const receivedTax = object({ schemeId: nullable(str()), name: nullable(str()), amount: nullable(str()), taxableAmount: nullable(str()), percent: nullable(str()), affectationCode: nullable(str()) });
  const receivedItem = object({ lineId: str(), supplierCode: nullable(str()), sunatCode: nullable(str()), description: str(), unitCode: nullable(str()), quantity: nullable(str()),
    unitValue: nullable(str()), unitPrice: nullable(str()), lineExtensionAmount: nullable(str()),
    allowances: array(object({ charge: bool, amount: nullable(str()), reason: nullable(str()) })), taxes: array(receivedTax) });
  const receivedProjection = object({ schemaVersion: { const: 'factuez.received-document.v1' }, documentType: str(), fullNumber: str(), series: str(), number: str(), issueDate: str(),
    issueTime: nullable(str()), dueDate: nullable(str()), currencyCode: nullable(str()), supplier: receivedParty, recipient: receivedParty, items: array(receivedItem),
    totals: object(Object.fromEntries(['lineExtensionAmount', 'taxExclusiveAmount', 'taxInclusiveAmount', 'allowanceTotalAmount', 'chargeTotalAmount', 'prepaidAmount', 'payableAmount'].map(key => [key, nullable(str())]))),
    taxes: array(receivedTax), paymentTerms: array(object({ id: nullable(str()), means: nullable(str()), amount: nullable(str()), dueDate: nullable(str()) })),
    references: array(object({ kind: str(), number: nullable(str()), documentType: nullable(str()) })), notes: array(str()), warnings: array(str()), xmlSha256: str(),
    signature: object({ status: enumeration('MISSING', 'PRESENT_UNVERIFIED'), officialTrust: { const: false } }) });
  const receivedFilters = [query('companyId', companyId), query('branchId', uuid, 'Requiere companyId.'), query('q', str(100)), query('type', { type: 'string', pattern: '^\\d{2}$' }),
    query('from', date), query('to', date), query('page', { ...integer(1, 99999), default: 1 }), query('dataSource', { ...source, default: 'BUSINESS' })];
  const uploadFile = object({ fileName: { ...str(150), minLength: 1, description: 'Nombre sin rutas, controles, .. ni caracteres reservados.' },
    contentBase64: { ...str(5592408), minLength: 4, contentEncoding: 'base64', description: 'Base64 canónico; máximo 4 MiB por archivo.' } });
  const received = (id: string, title: string, permission: string, params: Parameter[], success: number, result: Schema, input?: Schema, description = '') =>
    operation(id, title, 'Recepción', permission, params, success, result, input,
      'Sólo empresas BETA del catálogo autorizado; también requiere document.view para el catálogo. Recepción no verifica SUNAT: NOT_CHECKED. ' + description,
      [400, 401, 403, 404, 409, 503]);
  return {
    '/api/v1/auth/login': { post: { ...operation('Login', 'Iniciar sesión con contraseña', 'Login y sesión', '', [], 200, object(access), login,
      'Entrega accessToken Bearer, tokenType y expiresIn; no crea cookie de navegador.', [400, 401, 503]), security: [] } },
    '/api/v1/auth/me': { get: operation('Me', 'Consultar identidad vigente', 'Login y sesión', '', [], 200, claims, undefined, 'Verifica firma, vigencia y revocación.', [401, 503]) },
    '/api/v1/auth/browser-session/login': { post: browser('BrowserLogin', 'Iniciar sesión de navegador', [origin], sessionResponse, login,
      'Crea cookie de sesión y revoca la anterior si es válida. La cookie no se devuelve en JSON.', true) },
    '/api/v1/auth/browser-session': { get: browser('BrowserRestore', 'Restaurar sesión de navegador', [], sessionResponse, undefined,
      'Renueva JWT sin modificar lastActivityAt ni prolongar la inactividad en Redis. No requiere Origin.') },
    '/api/v1/auth/browser-session/activity': { post: browser('BrowserActivity', 'Registrar actividad humana', [origin], object(sessionTiming), undefined,
      'Actualiza actividad y renueva cookie tras verificar acceso vigente.') },
    '/api/v1/auth/browser-session/logout': { post: browser('BrowserLogout', 'Cerrar sesión de navegador', [origin], object({ loggedOut: { const: true } }), undefined,
      'Revoca la cookie si existe y la expira. Admite ausencia de cookie; cookie malformada devuelve 401.', false, true) },
    '/api/v1/stations/admin/catalog': { get: master('StationCatalog', 'Consultar emisores, sedes, puntos y series', 'setup.manage', [], 200, catalog) },
    '/api/v1/stations/issuers': { post: master('CreateIssuer', 'Registrar emisor BETA', 'setup.manage', [], 201, issuer,
      object({ ruc, ...issuerFields }, ['ruc', 'legalName', 'taxAddress', 'ubigeo']), 'Siempre crea BETA activo. RUC inmutable.') },
    '/api/v1/stations/issuers/{id}': {
      patch: master('UpdateIssuer', 'Actualizar datos del emisor', 'setup.manage', [path('id', companyId)], 200, issuer,
        { ...object({ expectedRevision: revision, ...issuerFields, active: bool }, ['expectedRevision']), minProperties: 2 }),
      delete: master('DeactivateIssuer', 'Desactivar emisor', 'setup.manage', [path('id', companyId)], 200, issuer, object({ expectedRevision: revision })),
    },
    '/api/v1/stations/issuers/{id}/environment': { post: master('IssuerEnvironment', 'Cambiar emisor sin uso a PRODUCCIÓN', 'setup.manage y sunat.configure', [path('id', companyId)], 201,
      object({ id: companyId, ruc, environment: { const: 'PRODUCTION' }, revision }), object({ expectedRevision: revision, environment: { const: 'PRODUCTION' }, confirmation: { const: 'CAMBIAR EMISOR A PRODUCCIÓN' } }),
      'Transición única desde BETA activo sin documentos, resúmenes, Outbox ni numeración consumida. No activa los envíos fiscales.') },
    '/api/v1/stations': { post: master('CreateBranch', 'Crear sede', 'setup.manage', [], 201, branch,
      object({ companyId, ...masterFields, establishmentCode }, ['companyId', 'code', 'name'])) },
    '/api/v1/stations/{id}': {
      patch: master('UpdateBranch', 'Actualizar sede', 'setup.manage', [path()], 200, branch,
        { ...object({ expectedRevision: revision, ...masterFields, establishmentCode, active: bool }, ['expectedRevision']), minProperties: 2 }),
      delete: master('DeactivateBranch', 'Desactivar sede', 'setup.manage', [path()], 200, branch, object({ expectedRevision: revision })),
    },
    '/api/v1/stations/{id}/issuer': { patch: master('AssignIssuer', 'Asignar emisor a sede sin puntos', 'setup.manage', [path()], 200, branch,
      object({ companyId, expectedRevision: revision }), 'Sólo sede activa sin puntos; no traslada historial.') },
    '/api/v1/stations/{id}/points': { post: master('CreatePoint', 'Crear punto y series 01/03', 'series.manage', [path()], 201,
      object({ id: uuid, companyId, branchId: uuid, code: str(), name: str(), active: bool, revision, series: array(object({ id: uuid, documentType: seriesType, series: seriesName, revision })) }),
      object({ ...masterFields, trackNumber, invoiceSeries: { type: 'string', pattern: '^[Ff][A-Za-z0-9]{3}$' }, receiptSeries: { type: 'string', pattern: '^[Bb][A-Za-z0-9]{3}$' } }, ['code', 'name', 'invoiceSeries', 'receiptSeries'])) },
    '/api/v1/stations/points/{id}': {
      patch: master('UpdatePoint', 'Actualizar punto', 'series.manage', [path()], 200, point,
        { ...object({ expectedRevision: revision, ...masterFields, trackNumber, active: bool }, ['expectedRevision']), minProperties: 2 }),
      delete: master('DeactivatePoint', 'Desactivar punto', 'series.manage', [path()], 200, point, object({ expectedRevision: revision })),
    },
    '/api/v1/stations/points/{id}/series': { post: master('CreateSeries', 'Crear serie', 'series.manage', [path()], 201, series, object({ documentType: seriesType, series: seriesName })) },
    '/api/v1/stations/series/{id}': {
      patch: master('UpdateSeries', 'Actualizar serie sin reiniciar correlativo', 'series.manage', [path()], 200, series,
        { ...object({ expectedRevision: revision, series: seriesName, active: bool }, ['expectedRevision']), minProperties: 2 }, 'Renombrar sólo si nextNumber=1 y no hay documentos.'),
      delete: master('DeactivateSeries', 'Desactivar serie', 'series.manage', [path()], 200, series, object({ expectedRevision: revision })),
    },
    '/api/v1/stations/products': {
      get: productOp('ListProducts', 'Consultar productos', [], 200, array(product)),
      post: productOp('CreateProduct', 'Crear producto', [], 201, product, object({ ...productFields, expectedUpdatedAt: dateTime }, ['sku', 'description', 'category', 'unitCode', 'taxAffectationCode'])),
    },
    '/api/v1/stations/products/{id}': { patch: productOp('UpdateProduct', 'Actualizar o desactivar producto', [path()], 200, product,
      { ...object({ ...productFields, expectedUpdatedAt: dateTime }, ['expectedUpdatedAt']), minProperties: 2 }) },
    '/api/v1/users': {
      get: identityOp('ListUsers', 'Consultar usuarios del alcance', 'user.manage', [], 200, array(user)),
      post: identityOp('CreateUser', 'Crear usuario y asignaciones', 'user.manage y role.manage', [], 201, user,
        object({ username: { type: 'string', pattern: '^[a-zA-Z0-9._-]{3,80}$' }, fullName: { ...str(160), minLength: 1 }, password: { ...str(256), minLength: 12, format: 'password', writeOnly: true },
          roles: userFields.roles, branchIds: ids, emissionPointIds: ids, series: seriesIds }, undefined, false),
        'Delegación limitada a facultades del actor; roles distintos de ADMIN requieren sede. Asignaciones verificadas contra Billing.'),
    },
    '/api/v1/users/{id}/access': { patch: identityOp('UpdateUserAccess', 'Actualizar acceso o desactivar usuario', 'user.manage y role.manage', [path()], 200, user,
      { ...object(userFields, []), minProperties: 1 }, 'No permite modificar el acceso propio. Incrementa authVersion y revoca sesiones; reactivar exige recursos vigentes.') },
    '/api/v1/users/{id}/permissions': {
      get: identityOp('ReadUserPermissions', 'Consultar permisos adicionales', 'user.manage y role.manage; ADMIN GLOBAL', [path()], 200, extra),
      patch: identityOp('UpdateUserPermissions', 'Reemplazar permisos adicionales', 'user.manage y role.manage; ADMIN GLOBAL', [path()], 200, extra,
        object({ permissions: extraPermissions, expectedAuthVersion: integer() }), 'Concurrencia por expectedAuthVersion; protege ADMIN y acceso propio; revoca sesiones.'),
    },
    '/api/v1/roles': { get: identityOp('ListRoles', 'Consultar roles y permisos', 'role.manage', [], 200, array(role)) },
    '/api/v1/roles/{code}': { patch: identityOp('UpdateRole', 'Reemplazar permisos de rol', 'role.manage; ADMIN GLOBAL', [path('code', enumeration('STATION_MANAGER', 'CASHIER', 'TRACK_OPERATOR', 'AUDITOR'))], 200,
      object({ code: roles, permissions, affectedUsers: integer() }), object({ permissions, expectedPermissions: permissions }), 'expectedPermissions debe coincidir con el conjunto vigente; ADMIN protegido. Revoca sesiones de usuarios afectados.') },
    '/api/v1/stations/print-settings/{companyId}': {
      get: printing('ReadPrintSettings', 'Consultar formato y logo efectivos', 200, printResult),
      post: printing('SavePrintSettings', 'Guardar formato o logo', 201, printResult, object({ expectedRevision: integer(0, 999999999), ...draftFields }, ['expectedRevision', 'settings'])),
    },
    '/api/v1/stations/print-settings/{companyId}/snapshot': { get: operation('ReadPrintSnapshot', 'Consultar presentación para impresión', 'Formatos y logos', 'document.view', printParams, 200,
      printSnapshot, undefined, 'BETA y almacenamiento habilitado; alcance de sede vigente. Puede leer maestros históricos inactivos.', [400, 401, 403, 409, 503]) },
    '/api/v1/stations/print-settings/{companyId}/preview': { post: binary(printing('PreviewPrintSettings', 'Vista previa de diseño sin emisión', 201, {},
      object({ documentTypeCode: enumeration('01', '03', '07', '08', '09', '31'), format: enumeration('a4', 'ticket'), draft }, ['documentTypeCode', 'format'])), ['application/pdf']) },
    '/api/v1/documents/catalog/issuance': { get: docs('IssuanceCatalog', 'Consultar catálogo de emisión autorizado', 'document.view', [], 200,
      object({ companies: array(object({ id: companyId, ruc, legalName: str(), environment: enumeration('BETA', 'PRODUCTION'), source: enumeration('BUSINESS', 'SYNTHETIC') })),
        catalogPolicy: object({ sourceRule: { const: 'RUC00' }, defaultSource: { const: 'BUSINESS' }, historyIncludesAllSources: { const: true } }),
        capabilities: object({ fiscalTransmission: { const: false }, productionInvoiceAdmission: bool, demoData: bool }),
        branches: array({ type: 'object', properties: { id: uuid, companyId, ...masterFields, establishmentCode, active: bool, source: enumeration('BUSINESS', 'SYNTHETIC') },
          required: ['id', 'companyId', 'code', 'name', 'address', 'establishmentCode', 'active', 'source'] }),
        emissionPoints: array(object({ id: uuid, code: str(), name: str(), branchId: nullable(uuid), companyId, source: enumeration('BUSINESS', 'SYNTHETIC'), trackNumber,
          series: array(object({ id: uuid, documentType: seriesType, series: seriesName })) })),
        products: array(object({ id: uuid, sku: str(), description: str(), unitCode: str(), taxAffectationCode: str(), defaultUnitPrice: nullable(str()) })) })) },
    '/api/v1/documents/dashboard': { get: docs('DocumentDashboard', 'Consultar indicadores del día en Lima', 'report.view', documentFilters, 200,
      object({ date, dataSource: source, currencyCode: { const: 'PEN' }, updatedAt: dateTime, count: integer(), amount: str(), igv: str(),
        states: array(object({ status: str(), count: integer() })), types: array(object({ type: str(), count: integer(), amount: str() })),
        points: array(object({ pointId: uuid, count: integer(), amount: str() })) }, ['date', 'currencyCode', 'updatedAt', 'count', 'amount', 'igv', 'states', 'types', 'points'])) },
    '/api/v1/documents/preview': { post: docs('PreviewDocument', 'Calcular ítems y totales', 'document.issue', [], 201, calculated,
      object({ lines: array(previewLine, 1, 100) }, ['lines'], false), 'No numera, persiste ni envía a SUNAT. El perfil de emisión exige afectación 10 e IGV 18.') },
    '/api/v1/documents': {
      get: docs('ListDocuments', 'Consultar comprobantes emitidos', 'document.view', [...documentFilters, query('page', { ...integer(1, 100000), default: 1 }), query('q', str(100))], 200,
        object({ page: integer(1), pageSize: { const: 20 }, dataSource: source, total: integer(), items: array(documentRow) }, ['page', 'pageSize', 'total', 'items'])),
      post: docs('IssueDocument', 'Registrar factura 01 o boleta 03', 'document.issue', [header('Idempotency-Key', { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$',
        description: 'Ámbito por usuario. Mismo cuerpo devuelve documento previo; otro cuerpo con misma clave devuelve 409.' }), header('X-Correlation-Id', str(), false)], 202,
        issueResult, issueInput, 'INVOICE=01 y serie Fxxx; SALES_RECEIPT=03 y serie Bxxx. Perfil: operación 0101, afectación 10, IGV 18%. Factura requiere RUC de 11 dígitos. Producción: PEN, sesión humana, habilitación y autorización fiscal vigentes. Numeración y Outbox atómicos. 202 no prueba aceptación SUNAT; no existe edición del comprobante emitido.'),
    },
    '/api/v1/documents/{documentId}': { get: docs('ReadDocument', 'Consultar comprobante y snapshot inmutable', 'document.view', [path('documentId')], 200,
      object({ id: uuid, companyId, fullNumber: str(), sunatStatus: str(), sunatResponseDescription: nullable(str()), immutableSnapshot: snapshot,
        printContext: object({ companyId, branchId: nullable(uuid) }), fiscalTransmission: { const: false } })) },
    [receivedBase]: {
      get: received('ListReceived', 'Consultar documentos recibidos', 'report.view', receivedFilters, 200,
        object({ items: array(receivedRow), page: integer(1), pageSize: { const: 25 }, total: integer() })),
      post: received('ImportReceived', 'Importar originales XML/ZIP', 'setup.manage', [], 201,
        object({ results: array(object({ fileName: str(), outcome: enumeration('IMPORTED', 'DUPLICATE', 'REJECTED'), id: uuid, message: str() }, ['fileName', 'outcome', 'message'])) }),
        object({ companyId, branchId: uuid, files: array(uploadFile, 1, 10) }, ['companyId', 'files'], false),
        'JSON con archivos base64, no multipart. Sede obligatoria para alcance ASSIGNED. Deduplicación por destinatario/proveedor/tipo/serie/número y hash XML+sede; no usa Idempotency-Key ni sobrescribe originales. Puede devolver REJECTED por archivo con HTTP 201.'),
    },
    [receivedBase + '/export.xlsx']: { get: binary(received('ExportReceived', 'Exportar recepción e ítems', 'report.export', receivedFilters, 200, {}, undefined,
      'Máximo 1.000 documentos y 10.000 ítems; acotar fechas si se excede.'), ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) },
    [receivedBase + '/{id}']: { get: received('ReadReceived', 'Consultar detalle y originales recibidos', 'report.view', [path()], 200,
      object({ ...(receivedRow.properties as Record<string, Schema>), projection: receivedProjection, artifacts: array(receivedArtifact) })) },
    [receivedBase + '/{id}/pdf']: { get: binary(received('ReceivedPdf', 'Descargar PDF de lectura', 'report.export', [path()], 200, {}, undefined,
      'Representación de lectura no fiscal; vuelve a autorizar incluso en caché.'), ['application/pdf']) },
    [receivedBase + '/{id}/artifacts/{artifactId}']: { get: binary(received('ReceivedArtifact', 'Descargar original recibido', 'report.export', [path(), path('artifactId')], 200, {}, undefined,
      'Verifica hash y longitud antes de descargar.'), ['application/pdf', 'application/xml', 'application/zip']) },
    [receivedBase + '/{id}/artifacts']: { post: received('AttachReceived', 'Adjuntar PDF del proveedor o CDR', 'setup.manage', [path()], 201,
      object({ id: uuid, duplicate: bool }), object({ kind: enumeration('PROVIDER_PDF', 'CDR'), ...(uploadFile.properties as Record<string, Schema>) }, undefined, false),
      'Máximo 20 originales; deduplica por documento/tipo/hash. CDR XML o ZIP debe corresponder al documento; PDF requiere firma de archivo PDF.') },
    [receivedBase + '/{id}/registration']: { patch: received('RegisterReceived', 'Registrar referencia contable o ERP', 'setup.manage', [path()], 200,
      object({ registered: bool, erpReference: nullable(str()) }), object({ registered: bool, erpReference: str(150) }, ['registered'], false),
      'registered=true exige erpReference no vacía. false quita referencia; sólo cambia metadatos de recepción.') },
    [receivedBase + '/{id}/assignment']: { patch: received('AssignReceived', 'Asignar sede de recepción', 'setup.manage y ADMIN GLOBAL', [path()], 200,
      object({ branchId: nullable(uuid) }), object({ branchId: nullable(uuid), expectedBranchId: nullable(uuid) }),
      'Concurrencia por expectedBranchId; null representa recepción aún sin sede. No altera emisor, destinatario ni XML.') },
  };
}
