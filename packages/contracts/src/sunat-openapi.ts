/** Documentation of actual intranet controllers; never calls SUNAT or loads credentials. */
type Shape = Record<string, unknown>;
const string = (description?: string): Shape => ({ type: 'string', ...(description ? { description } : {}) });
const secret: Shape = { type: 'string', minLength: 1, maxLength: 512, format: 'password', writeOnly: true };
const ref = (name: string): Shape => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, Shape>, required = Object.keys(properties)): Shape => ({ type: 'object', additionalProperties: false, properties, required });
const companyId: Shape = { name: 'companyId', in: 'path', required: true, schema: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' }, description: 'ID de empresa de Billing, no el RUC. Seleccionarlo en el catálogo autorizado.' };
const environment: Shape = { name: 'environment', in: 'path', required: true, schema: { type: 'string', enum: ['BETA', 'PRODUCTION'] }, description: 'Ambiente de las credenciales. PRODUCTION sólo almacena una configuración separada; no habilita emisión.' };
const documentId: Shape = { name: 'documentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const page: Shape = { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 999999, default: 1 } };
const companyQuery: Shape = { name: 'companyId', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } };
const privateHeaders = { 'Cache-Control': { schema: { type: 'string', const: 'private, no-store' } } };
const json = (schema: Shape, description: string): Shape => ({ description, headers: privateHeaders, content: { 'application/json': { schema } } });
const errors = Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [String(status), json({ type: 'object', description: 'Error seguro del servicio; el formato no es el envelope de la API de integración.' }, `HTTP ${status}: entrada, sesión, autorización, revisión o fuente no disponible`)]));
function operation(id: string, summary: string, tag: string, parameters: Shape[], description: string, schema: Shape = { type: 'object', description: 'Respuesta del servicio propietario; consulte su descripción y la guía.' }): Record<string, unknown> {
  return { operationId: id, summary, tags: [tag], parameters, description, security: [{ HumanSessionBearer: [] }], 'x-access-plane': 'HUMAN_INTRANET', 'x-remote-erp-access': false, responses: { '200': json(schema, 'Respuesta autorizada'), ...errors } };
}
const body = (schema: Shape): Shape => ({ required: true, content: { 'application/json': { schema } } });
export function sunatAdministrationOpenApiV1(): Record<string, unknown> {
  const base = '/api/v1/setup/sunat/{companyId}/{environment}';
  const save = operation('saveSunatConfiguration', 'Guardar, reemplazar o retirar credenciales', 'Configuración fiscal', [companyId, environment], 'Sólo ADMIN global + sunat.configure; HTTPS (localhost permitido para desarrollo). expectedRevision evita sobrescrituras. Los grupos omitidos se conservan; remove retira sólo grupos activos. No combinar reemplazo y retiro del mismo grupo. Cifrado y auditoría por RUC/ambiente. Sin transmisión a SUNAT, autenticación SOL ni activación fiscal. Respuesta POST normal de Nest: 201.', ref('ConfigurationStatus'));
  save.requestBody = body(ref('ConfigurationInput'));
  save.responses = { '201': json(ref('ConfigurationStatus'), 'Configuración guardada, sin transmitir'), ...errors };
  const validate = operation('validateSunatSnapshot', 'Validar un snapshot sin emitir ni guardar ventas', 'Preparación fiscal', [companyId, environment], 'Sólo ADMIN global + sunat.configure. Debe corresponder al emisor y ambiente. No firma, no envía, no reserva correlativos; persisted:false y official:false. Se documenta el contenedor; el snapshot fiscal interno no es el DocumentDetail de extracción.');
  validate.requestBody = body(obj({ snapshot: { type: 'object', description: 'FiscalDocumentSnapshot del perfil interno; consulte el contrato del emisor. No se aceptan otros campos en el contenedor.' } }));
  validate.responses = { '201': json({ type: 'object' }, 'Resultado de validación local; no emisión'), ...errors };
  const pdf = operation('downloadIntranetLocalPdf', 'PDF de desarrollo para ticket o A4', 'Consulta intranet', [documentId, { name: 'format', in: 'path', required: true, schema: { type: 'string', enum: ['ticket', 'a4'] } }], 'Sesión humana con document.view y alcance del documento. Representación temporal sólo para documentos Beta locales en QUEUED/BUILDING. No es XML/CDR ni prueba de aceptación. No sustituye el endpoint de artefactos ERP.');
  pdf.responses = { '200': { description: 'PDF local de prueba', headers: { ...privateHeaders, 'Content-Disposition': { schema: string() }, 'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } } }, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...errors };
  const receptionBase = '/api/v1/received-documents/automation';
  const connectionSave = operation('saveReceivedConnection', 'Guardar conexión SIRE/correo por empresa', 'Compras recibidas · SIRE', [companyQuery], 'ADMIN global + setup.manage. Revisión concurrente, secretos cifrados y auditoría. Guardar no elimina los bloqueos de TI: LIVE_READ_ONLY requiere autorización de salida y hosts de correo aprobados. LOCAL_FIXTURE sólo admite emisores ficticios. Contraseñas omitidas o vacías conservan las actuales; cambiar cuenta/host invalida el secreto anterior relacionado.');
  connectionSave.requestBody = body(ref('ReceivedConnectionInput'));
  const receivedId: Shape = { name: 'documentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const receivedFilters: Shape[] = [
    { ...companyQuery, required: false }, { name: 'branchId', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Requiere companyId y pertenencia autorizada.' },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 99999, default: 1 } },
    { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 }, description: 'Número, proveedor o RUC del proveedor.' },
    { name: 'type', in: 'query', schema: { type: 'string', pattern: '^[0-9]{2}$' } },
    ...['from', 'to'].map(name => ({ name, in: 'query', schema: { type: 'string', format: 'date' } })),
    { name: 'dataSource', in: 'query', schema: { type: 'string', enum: ['BUSINESS', 'SYNTHETIC', 'ALL'], default: 'BUSINESS' } },
  ];
  const receivedDownload = operation('downloadReceivedOriginal', 'Descargar original recibido del proveedor', 'Compras recibidas · SIRE', [receivedId, { name: 'artifactId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], 'report.export más acceso al catálogo de emisión y alcance del documento. Utiliza el id del archivo devuelto en el detalle; entrega los bytes almacenados y verifica pertenencia/integridad. No consulta SUNAT ni crea un XML a partir de SIRE. No forma parte del OAuth ERP de emitidos.');
  receivedDownload.responses = { '200': { description: 'Original XML, ZIP o PDF del proveedor, según inventario', headers: privateHeaders, content: Object.fromEntries(['application/xml', 'application/zip', 'application/pdf'].map(type => [type, { schema: { type: 'string', format: 'binary' } }])) }, ...errors };
  const sync = operation('queueReceivedReadSync', 'Solicitar lectura de compras/correo autorizada', 'Compras recibidas · SIRE', [], 'ADMIN global + setup.manage. Sólo encola si el conector está preparado. Puede contactar SIRE/correo mediante el worker cuando TI autorice LIVE_READ_ONLY; este visor NO ejecuta la operación. No presenta el RCE ni envía comprobantes. SIRE no garantiza XML completo por ítem: se requiere el archivo original del proveedor/correo.');
  sync.requestBody = body(obj({ companyId: { type: 'integer', minimum: 1 }, source: { type: 'string', enum: ['MAIL', 'SIRE', 'ALL'] } }));
  sync.responses = { '201': json(obj({ queued: { type: 'integer', minimum: 0, maximum: 2 } }), 'Trabajos encolados, no finalizados'), ...errors };
  return {
    openapi: '3.1.1', info: { title: 'FactuEz · SUNAT y consultas intranet', version: '1.0.0', description: 'Referencia de controladores existentes de la PWA. Autenticación humana, NO OAuth M2M de extracción. No deben publicarse en la entrada remota ERP. Configurar certificados no activa despacho oficial. El visor no ejecuta operaciones ni carga credenciales reales. El laboratorio SOAP/REST simulado se describe en la guía, no se presenta como SUNAT oficial.' },
    servers: [{ url: '/', description: 'Origen intranet actual; no constituye habilitación fiscal.' }], security: [{ HumanSessionBearer: [] }],
    tags: ['Configuración fiscal', 'Preparación fiscal', 'Consulta intranet', 'Compras recibidas · SIRE'].map(name => ({ name })),
    paths: {
      [base]: { get: operation('getSunatConfiguration', 'Consultar metadatos de configuración', 'Configuración fiscal', [companyId, environment], 'ADMIN global + sunat.configure. Devuelve presencia de certificado/SOL/GRE, huella, vencimiento y revisión; nunca P12, contraseña ni valores cifrados.', ref('ConfigurationStatus')), post: save },
      [`${base}/audit`]: { get: operation('listSunatConfigurationAudit', 'Historial de cambios del RUC y ambiente', 'Configuración fiscal', [companyId, environment, page], 'ADMIN global + sunat.configure. Diez registros por página con total. Campos: id, actorId, fields, revision, occurredAt; nunca secretos.') },
      [`${base}/readiness`]: { get: operation('getSunatReadiness', 'Revisión local de preparación y bloqueos', 'Preparación fiscal', [companyId, environment], 'ADMIN global + sunat.configure. Examina bóveda, certificado/identidad/cadena/CRL offline y cobertura de reglas. No autentica con SUNAT. Esta versión devuelve readyForOfficialBeta:false, readyForProduction:false y fiscalTransmission:false.') },
      [`${base}/readiness/validate`]: { post: validate },
      '/api/v1/fiscal-artifacts/{documentId}/{format}': { get: pdf },
      '/api/v1/fiscal-evidence/{documentId}': { get: operation('getIntranetFiscalEvidence', 'Consultar seguimiento fiscal vinculado al documento', 'Consulta intranet', [documentId], 'Sesión humana y acceso autorizado al documento. Versiones y solicitudes asociadas; un registro o respuesta simulada no acredita aceptación oficial. No entrega P12 ni claves.') },
      [`${receptionBase}/config`]: { get: operation('getReceivedConnectionMetadata', 'Consultar configuración de recepción por empresa', 'Compras recibidas · SIRE', [companyQuery], 'ADMIN global + setup.manage. Devuelve settings y presencia booleana de secretos; nunca contraseñas. liveReadAllowed y state indican si requiere TI. No comparte credenciales GRE ni token ERP.'), patch: connectionSave },
      [`${receptionBase}/runs`]: { get: operation('listReceivedSyncRuns', 'Últimas ejecuciones de recepción', 'Compras recibidas · SIRE', [companyQuery], 'ADMIN global + setup.manage. Hasta 30 ejecuciones: estado, contadores y código seguro de error; no es historial completo paginado.') },
      [`${receptionBase}/incidents`]: { get: operation('listReceivedSyncIncidents', 'Incidencias de recepción pendientes', 'Compras recibidas · SIRE', [companyQuery], 'ADMIN global + setup.manage. Hasta 100 incidencias activas; no cuerpos XML ni logs completos.') },
      [`${receptionBase}/discoveries`]: { get: operation('listSireDiscoveries', 'Compras detectadas y vínculo con XML original', 'Compras recibidas · SIRE', [companyQuery, { name: 'branchId', in: 'query', schema: { type: 'string', format: 'uuid' } }], 'report.view más acceso al catálogo de emisión y alcance autorizado. Hasta 100 detecciones; xmlStatus distingue coincidencia, pendiente o diferencia. No son ítems XML reconstruidos desde totales SIRE.') },
      [`${receptionBase}/sync`]: { post: sync },
      '/api/v1/received-documents': { get: operation('listReceivedDocuments', 'Listado de compras con XML recibido', 'Compras recibidas · SIRE', receivedFilters, 'report.view más acceso al catálogo de emisión. Página de 25 documentos con total; filtrada por empresas y sedes autorizadas. No es el listado de todos los comprobantes de SUNAT; contiene lo recibido e incorporado a FactuEz.') },
      '/api/v1/received-documents/{documentId}': { get: operation('getReceivedDocument', 'Detalle por ítem e inventario de adjuntos del proveedor', 'Compras recibidas · SIRE', [receivedId], 'report.view más acceso al catálogo de emisión y alcance. Incluye projection con detalle XML disponible, y artifacts con id, kind, fileName, sha256 y byteLength. sunatStatus permanece NOT_CHECKED mientras no exista verificación oficial; no implica aceptación.') },
      '/api/v1/received-documents/{documentId}/artifacts/{artifactId}': { get: receivedDownload },
    },
    components: {
      securitySchemes: { HumanSessionBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT de sesión PWA', description: 'Access token humano vigente y autorizado por Identity. No confundir con token ERP ni credenciales SOL. No introducirlo en este visor de sólo lectura.' } },
      schemas: {
        ReceivedConnectionInput: obj({ expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
          settings: obj({ enabled: { type: 'boolean' }, mode: { type: 'string', enum: ['LOCAL_FIXTURE', 'LIVE_READ_ONLY'] }, intervalMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
            mailbox: obj({ enabled: { type: 'boolean' }, host: { type: 'string', maxLength: 253 }, port: { type: 'integer', const: 993 }, folder: { type: 'string', minLength: 1, maxLength: 150 }, username: { type: 'string', maxLength: 254 } }),
            sire: obj({ enabled: { type: 'boolean' }, startPeriod: { type: 'string', pattern: '^20[0-9]{2}(0[1-9]|1[0-2])$', description: 'YYYYMM, no posterior al periodo actual de Lima.' }, clientId: { type: 'string', maxLength: 150 }, solUsername: { type: 'string', maxLength: 64, description: 'Usuario secundario sin RUC como prefijo.' } }),
          }), credentials: obj(Object.fromEntries(['mailPassword', 'sireClientSecret', 'solPassword'].map(name => [name, { type: 'string', maxLength: 1024, format: 'password', writeOnly: true }])), []),
        }, ['expectedRevision', 'settings']),
        ConfigurationStatus: obj({ ruc: { type: 'string', pattern: '^[0-9]{11}$' }, environment: { type: 'string', enum: ['BETA', 'PRODUCTION'] }, revision: { type: 'integer', minimum: 0 }, updatedAt: { type: ['string', 'null'], format: 'date-time' },
          certificate: obj({ configured: { type: 'boolean' }, fingerprint: { type: ['string', 'null'] }, expiresAt: { type: ['string', 'null'], format: 'date-time' }, selfSigned: { type: ['boolean', 'null'] }, expired: { type: 'boolean' }, trustAndRucVerified: { type: 'boolean', const: false } }), solConfigured: { type: 'boolean' }, greConfigured: { type: 'boolean' }, fiscalTransmission: { type: 'boolean', const: false } }),
        ConfigurationInput: obj({ expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
          certificate: obj({ fileName: { type: 'string', pattern: '\\.(?:[pP]12|[pP][fF][xX])$', description: 'Extensión validada sin distinguir mayúsculas; archivo PKCS#12 hasta 512 KiB.' }, base64: { type: 'string', contentEncoding: 'base64', maxLength: 699052, writeOnly: true }, password: secret }),
          sol: obj({ username: { type: 'string', pattern: '^[A-Za-z0-9._-]{3,80}$', writeOnly: true, description: 'Usuario secundario, sin RUC prefijado.' }, password: secret }),
          gre: obj({ clientId: { type: 'string', minLength: 1, maxLength: 160, writeOnly: true }, clientSecret: secret }), remove: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: ['certificate', 'sol', 'gre'] } },
        }, ['expectedRevision']),
      },
    },
  };
}
