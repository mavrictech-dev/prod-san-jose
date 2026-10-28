/** External minimal event contract; do not forward internal DocumentIssued snapshots. */
export const B2bWebhookVersion = 'factuez.webhook.v1' as const;
export const B2bWebhookEventNames = [
  'document.created.v1', 'document.issued-locally.v1',
  'document.tax-transport-updated.v1', 'document.tax-acceptance-verified.v1',
  'document.tax-rejection-verified.v1', 'document.artifact-available.v1',
  'credit-note.updated.v1', 'debit-note.updated.v1', 'guide.updated.v1',
  'export.ready.v1', 'email.delivery-updated.v1', 'received-document.imported.v1',
] as const;
export type B2bWebhookEventName = typeof B2bWebhookEventNames[number];

type Schema = Record<string, unknown>;
const text = (maxLength = 100): Schema => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, Schema>): Schema => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});
const uuid: Schema = { type: 'string', format: 'uuid' };
const timestamp: Schema = { type: 'string', format: 'date-time' };
const resource = (kinds: string[]): Schema => object({ kind: { type: 'string', enum: kinds }, id: uuid, version: text() });

/** All fields are explicit and closed. Actual signing/delivery belongs to B2B-05. */
export function b2bWebhookSchemas(): Record<string, Schema> {
  const variants = B2bWebhookEventNames.map(eventName => {
    const verified = eventName.includes('-verified.');
    const kind = eventName.startsWith('export.') ? ['EXPORT'] : eventName.startsWith('email.') ? ['EMAIL_DELIVERY']
      : eventName.startsWith('received-') ? ['RECEIVED_DOCUMENT'] : eventName.startsWith('guide.') ? ['GUIDE'] : ['DOCUMENT'];
    const payload: Record<string, Schema> = { resource: resource(kind) };
    if (verified) {
      payload.evidence = object({
        artifactId: uuid,
        provenance: { type: 'string', const: 'SUNAT_BETA' },
        signature: { type: 'string', const: 'VERIFIED' },
        trust: { type: 'string', const: 'VERIFIED' },
        identity: { type: 'string', const: 'MATCHED' },
        binding: { type: 'string', const: 'VERIFIED' },
        outcome: { type: 'string', const: eventName.includes('acceptance') ? 'ACCEPTED' : 'REJECTED' },
        checkedAt: timestamp,
      });
    } else {
      payload.provenance = { type: 'string', enum: ['LOCAL', 'LOCAL_SIMULATOR', 'SUNAT_BETA'] };
    }
    if (eventName === 'document.artifact-available.v1') {
      payload.artifactId = uuid;
      payload.artifactKind = { type: 'string', enum: ['SIGNED_XML', 'CDR_XML', 'SUBMISSION_ZIP', 'PDF_A4', 'PDF_TICKET'] };
    }
    return object({
      schemaVersion: { type: 'string', const: B2bWebhookVersion }, eventId: uuid,
      eventName: { type: 'string', const: eventName }, occurredAt: timestamp,
      issuerId: { type: 'integer', minimum: 1 }, environment: { type: 'string', const: 'BETA' },
      correlationId: uuid, payload: object(payload),
    });
  });
  return structuredClone({ WebhookEvent: { oneOf: variants } });
}

export function b2bWebhookCatalog() {
  return {
    schemaVersion: B2bWebhookVersion, status: 'DESIGN_ONLY_NOT_IMPLEMENTED',
    environment: 'BETA', events: [...B2bWebhookEventNames], schemas: b2bWebhookSchemas(),
    delivery: {
      semantics: 'AT_LEAST_ONCE', ordering: 'NOT_GLOBAL',
      eventId: 'Stable business event; receiver deduplicates durably.',
      deliveryId: 'Stable per subscription/event, including retries.',
      attemptId: 'Unique per HTTP attempt.',
      signature: {
        standard: 'Standard Webhooks', algorithm: 'HMAC-SHA256',
        headers: ['webhook-id', 'webhook-timestamp', 'webhook-signature'],
        webhookIdValue: 'deliveryId',
        signedContent: 'webhook-id + "." + webhook-timestamp + "." + exactRawBody',
        replayWindowSeconds: 300,
      },
      timeoutSeconds: 10, maxAttempts: 8, retryHorizonSeconds: 86400,
      verifiedDestinationRequired: true, redirectsAllowed: false,
      authorizedReplayRequired: true, currentGrantRequired: true,
      payloadContainsDownloadUrls: false, payloadContainsXml: false,
    },
  } as const;
}

/** Narrow implemented profile, never confuse the complete design vocabulary with runtime coverage. */
export function b2bWebhookAsyncApiCandidate(){
  const variant=(b2bWebhookSchemas().WebhookEvent as any).oneOf.find((v:any)=>v.properties.eventName.const==='document.issued-locally.v1');
  return {asyncapi:'3.0.0',info:{title:'FactuEz · local issuance webhooks candidate',version:'1.0.0'},defaultContentType:'application/json',
    'x-runtime-enabled':false,'x-supported-event':'document.issued-locally.v1','x-fiscal-acceptance':'NOT_ASSERTED',
    channels:{localIssuance:{address:'TI_APPROVED_CALLBACK',messages:{issued:{$ref:'#/components/messages/IssuedLocally'}}}},
    operations:{deliverLocalIssuance:{action:'send',channel:{$ref:'#/channels/localIssuance'},messages:[{$ref:'#/channels/localIssuance/messages/issued'}]}},
    components:{messages:{IssuedLocally:{name:'document.issued-locally.v1',contentType:'application/json',payload:variant,
      headers:{type:'object',required:['webhook-id','webhook-timestamp','webhook-signature'],properties:{'webhook-id':{type:'string',format:'uuid'},'webhook-timestamp':{type:'string',pattern:'^[1-9][0-9]{0,10}$'},'webhook-signature':{type:'string',description:'Standard Webhooks v1; one or two space-separated signatures during rotation'},'X-FactuEz-Attempt-Id':{type:'string',format:'uuid'}}},
      correlationId:{location:'$message.payload#/correlationId'}}}}};
}
