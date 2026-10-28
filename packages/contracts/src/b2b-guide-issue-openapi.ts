import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from './b2b-guide-security';

/** Apply after the shared context/guide schemas. Does not activate any route or grant. */
export function addB2bGuideIssueOpenApi(api: any) {
  const s = api.components.schemas;
  const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
  const obj = (properties: Record<string, any>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const uuid = { type: 'string', format: 'uuid' }, sha = { type: 'string', pattern: '^[a-f0-9]{64}$' };
  const revision = { type: 'string', pattern: '^"v[1-9][0-9]{0,8}"$' };
  const flags = Object.fromEntries(Object.entries({ candidateOnly: true, numberReserved: true, fiscalExecutionEnabled: false,
    transmissionAuthorized: false, authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false })
    .map(([k, value]) => [k, { type: 'boolean', const: value }]));
  s.GuideIssueBinding = obj({ draft: ref('GuideDraftBinding'), fiscalSeriesId: { ...uuid,
    description: 'Serie fiscal concedida explícitamente, distinta de la serie ancla y de metadatos del borrador.' } });
  s.GuideIssueBinding.properties.draft = structuredClone(s.GuideDraftBinding);
  s.GuideIssueBinding.properties.draft.properties.guideType = {type:'string',const:'09'};
  s.GuideIssueBinding.description = 'La tupla completa debe coincidir. El único perfil local candidato cubierto es guía 09 / transporte privado 02 / motivo 04.';
  s.GuideIssueBody = structuredClone(s.GuidePreparationBody);
  s.GuideIssueBody.properties.origin = { ...structuredClone(s.GuideDraftLocation), properties: {
    ...structuredClone(s.GuideDraftLocation.properties), address: { type: 'string', minLength: 1, maxLength: 300 } } };
  s.GuideIssueBody.properties.destination = structuredClone(s.GuideIssueBody.properties.origin);
  const driver = s.GuideIssueBody.properties.transport.properties.driver;
  driver.properties.identityNumber = { type: 'string', pattern: '^[A-Z0-9]{1,12}$', description: 'DNI (tipo 1): exactamente ocho dígitos; tipo 4: 1–12 letras mayúsculas/dígitos.' };
  s.GuideIssuedSnapshot = obj({ schemaVersion: { type: 'string', const: 'factuez.guide-issued-local.v1' }, documentId: uuid,
    operationId: uuid, binding: ref('GuideIssueBinding'), draftId: uuid, draftRevision: { type: 'integer', minimum: 1, maximum: 999999999 },
    issuer: ref('GuideDraftParty'), series: { type: 'string', pattern: '^T[A-Z0-9]{3}$' }, number: { type: 'string', pattern: '^[1-9][0-9]{0,7}$' },
    fullNumber: { type: 'string', pattern: '^T[A-Z0-9]{3}-[1-9][0-9]{0,7}$' }, body: ref('GuideIssueBody'), bodySha256: sha, contextSha256: sha,
    at: { type: 'string', format: 'date-time' }, ...flags });
  s.GuideIssuePublicRequest = obj({ binding: ref('GuideIssueBinding') });
  const view = { schemaVersion: { type: 'string', const: 'factuez.b2b.guide-issuance.v1' }, operationId: uuid, draftId: uuid,
    binding: ref('GuideIssueBinding'), snapshot: ref('GuideIssuedSnapshot'), snapshotSha256: sha };
  s.GuideIssuance = obj({ ...view, replayed: { type: 'boolean' } });
  s.GuideIssuanceRead = obj({ ...view, replayed: { type: 'null' } });
  api.tags ??= [];
  if (!api.tags.some((t: any) => t.name === 'guideissuance')) api.tags.push({ name: 'guideissuance',
    description: 'Emisión LOCAL candidata: reserva correlativo e inmoviliza snapshot; no valida reglas oficiales, no firma ni transmite a SUNAT, no verifica CDR ni autoriza traslado.' });
  const description = 'LOCAL candidato 09/02/04, sin referencias ni bienes regulados. Reserva correlativo en el propietario y conserva el snapshot inmutable. '
    + 'No implica validación oficial ni autorización para trasladar. Respuesta máxima 512 KiB; solicitud máxima 128 KiB. '
    + 'Bearer, actor explícito y mTLS fijado; identidad vigente antes y después. Se rechazan campos extra, alias y cabeceras/parámetros duplicados.';
  for (const read of [false, true]) {
    const parameters: any[] = [{ name: 'id', in: 'path', required: true, schema: uuid },
      { name: 'X-FactuEz-Actor-Kind', in: 'header', required: true, schema: { type: 'string', enum: ['SERVICE', 'USER'] } }];
    if (read) {
      parameters.push({ name: 'operationId', in: 'path', required: true, schema: uuid });
      for (const [name, schema] of Object.entries({ ...s.Context.properties, guideSeriesId: uuid,
        guideType: { type: 'string', const: '09' }, fiscalSeriesId: uuid })) parameters.push({ name, in: 'query', required: true, schema });
    } else parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' } },
      { name: 'If-Match', in: 'header', required: true, schema: revision });
    const responses: Record<string, any> = { '200': { description: read ? 'Snapshot LOCAL inmutable; replayed siempre null.' : 'Snapshot LOCAL; replayed indica repetición idempotente. Reintentar con la misma clave, tupla y revisión.',
      content: { 'application/json': { schema: ref(read ? 'GuideIssuanceRead' : 'GuideIssuance') } },
      headers: { ETag: { schema: revision }, ...(!read ? { 'Idempotency-Key': { schema: { type: 'string' } },
        'X-Operation-Id': { schema: uuid }, 'X-Idempotent-Replay': { schema: { type: 'string', enum: ['true', 'false'] } } } : {}) } } };
    for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 428, 429, 503]) responses[status] = {
      description: 'Error finito y saneado; no contiene respuesta interna ni credenciales. Un fallo posterior al commit puede requerir recuperar con la misma clave.',
      content: { 'application/json': { schema: ref('Error') } } };
    const path = '/b2b/v1/guide-drafts/{id}/' + (read ? 'issuances/{operationId}' : 'issuance');
    api.paths[path] = { [read ? 'get' : 'post']: { operationId: read ? 'b2bReadGuideIssuance' : 'b2bIssueGuideDraft', tags: ['guideissuance'],
      summary: read ? 'Leer emisión local candidata de guía' : 'Emitir candidato local de guía', description: description + (read ? ' GET sin cuerpo y diez parámetros planos obligatorios.' : ' POST sin query; cuerpo exacto {binding}.'),
      'x-source-implemented': true, 'x-runtime-enabled': false, 'x-candidate-only': true,
      'x-required-scopes': [...(read ? b2bGuideIssueReadScopes : b2bGuideIssueScopes)], security: [{ B2bBearer: [], PrivateTransport: [] }],
      parameters, ...(!read ? { requestBody: { required: true, content: { 'application/json': { schema: ref('GuideIssuePublicRequest') } } } } : {}), responses } };
  }
  return api;
}
