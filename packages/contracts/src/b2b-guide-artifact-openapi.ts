import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from './b2b-guide-security';
export function addB2bGuideArtifactOpenApi(api: any) {
  const s = api.components.schemas, ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
  const obj = (properties: any) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const uuid = { type: 'string', format: 'uuid' }, sha = { type: 'string', pattern: '^[a-f0-9]{64}$' };
  s.GuideArtifactBinding = structuredClone(s.GuideIssueBinding);
  s.GuideArtifactBinding.properties.draft.properties.guideType = {type:'string',enum:['09','31']};
  s.GuideArtifactBinding.description = 'Tupla concedida de tres series 09 o 31; el propietario conserva perfil y referencia completos.';
  s.GuideArtifactScope = obj({ binding: ref('GuideArtifactBinding'), draftId: uuid, operationId: uuid });
  const flags = Object.fromEntries(Object.entries({ candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
    authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false, certificateTrusted: false,
    signatureVerifiedLocally: true }).map(([key, value]) => [key, { type: 'boolean', const: value }]));
  s.GuideArtifactMetadata = obj({ schemaVersion: { type: 'string', const: 'factuez.guide-artifacts-local.v1' }, environment: { type: 'string', const: 'BETA' },
    scope: ref('GuideArtifactScope'), documentId: uuid, issuerRuc: { type: 'string', pattern: '^[0-9]{11}$' },
    fullNumber: { type: 'string', pattern: '^[TV][A-Z0-9]{3}-[1-9][0-9]{0,7}$' }, guideType: { type: 'string', enum: ['09','31'] },
    ownerRevision: { type: 'integer', minimum: 1, maximum: 2147483647 }, profile: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,120}$' },
    snapshotSha256: sha, unsignedXmlSha256: sha, xmlSha256: sha, zipSha256: sha, certificateFingerprintSha256: sha,
    digestValue: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' }, fileName: { type: 'string', maxLength: 100 }, ...flags });
  s.GuideArtifactView = obj({ schemaVersion: { type: 'string', const: 'factuez.b2b.guide-artifacts.v1' }, scope: ref('GuideArtifactScope'),
    metadata: ref('GuideArtifactMetadata'), replayed: { type: ['boolean','null'] } });
  api.tags.push({ name: 'guideartifacts', description: 'Originales de ensayo BETA local: XML firmado, ZIP, CDR XML/ZIP. No acredita firma fiscal ni aceptación oficial.' });
  const base = '/b2b/v1/guide-drafts/{id}/issuances/{operationId}/artifacts';
  for (const action of ['prepare','read','content']) {
    const prepare = action === 'prepare', binary = action === 'content', path = base + (binary ? '/{artifact}' : '');
    const parameters: any[] = [{ name: 'id', in: 'path', required: true, schema: uuid }, { name: 'operationId', in: 'path', required: true, schema: uuid },
      { name: 'X-FactuEz-Actor-Kind', in: 'header', required: true, schema: { type: 'string', enum: ['SERVICE','USER'] } }];
    if (!prepare) for (const [name, schema] of Object.entries({ ...s.Context.properties, guideSeriesId: uuid,
      guideType: { type: 'string', enum: ['09','31'] }, fiscalSeriesId: uuid })) parameters.push({ name, in: 'query', required: true, schema });
    if (binary) parameters.push({ name: 'artifact', in: 'path', required: true, schema: { type: 'string', enum: ['xml','zip','cdr-xml','cdr-zip'] } });
    const responses: any = { '200': { description: binary ? 'Original local, bytes íntegros; CDR sólo si capturado y verificado por el dueño.' : 'Metadatos inmutables locales. Preparación idempotente por operación; GET no firma ni reserva.',
      content: binary ? Object.fromEntries(['application/xml','application/zip'].map(type => [type, { schema: { type: 'string', format: 'binary' } }])) : { 'application/json': { schema: ref('GuideArtifactView') } },
      headers: binary ? { 'X-Content-Sha256': { schema: sha }, 'X-FactuEz-Source': { schema: { type: 'string', const: 'LOCAL_EMULATOR' } } } : {} } };
    for (const status of [400,401,403,404,409,413,429,503]) responses[status] = { description: 'Error finito sin secretos; 404 si no preparado/CDR ausente, nunca inventa un archivo.', content: { 'application/json': { schema: ref('Error') } } };
    api.paths[path] ??= {};
    api.paths[path][prepare ? 'post' : 'get'] = { operationId: 'b2bGuideArtifacts_' + action, tags: ['guideartifacts'],
      summary: prepare ? 'Preparar originales firmados locales de una guía numerada' : binary ? 'Descargar original XML/ZIP o CDR local' : 'Consultar metadatos de originales de una guía',
      description: 'BETA local; no usa producción ni autoriza traslado. Firma/correlativos/CDR del dueño, no datos fiscales inventados. Alcance completo y actor vigente, mTLS y Bearer. No se aceptan claves, XML subidos, rutas de almacenamiento ni banderas de aceptación.',
      parameters, security: [{ B2bBearer: [], PrivateTransport: [] }], 'x-source-implemented': true, 'x-runtime-enabled': false,
      'x-candidate-only': true, 'x-required-scopes': [...(prepare ? b2bGuideIssueScopes : b2bGuideIssueReadScopes)], responses,
      ...(prepare ? { requestBody: { required: true, content: { 'application/json': { schema: obj({ binding: ref('GuideArtifactBinding') }) } } } } : {}) };
  }
  return api;
}
