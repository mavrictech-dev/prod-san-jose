import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {b2bCandidateOpenApiV1} from '../packages/contracts/src/b2b-read-openapi';
import {b2bWebhookAsyncApiCandidate,b2bWebhookCatalog} from '../packages/contracts/src/b2b-webhooks';
const read=(p:string)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
describe('B2B-05 contract coverage and activation gates',()=>{
  it('documents nine actual webhook actions with independent scopes and subscription revision for replay',()=>{
    const api=b2bCandidateOpenApiV1(),ops=Object.entries(api.paths).filter(([p])=>p.includes('/webhook-')).flatMap(([,v]:any)=>Object.values(v));expect(ops).toHaveLength(9);
    for(const op of ops as any[]){expect(op['x-runtime-enabled']).toBe(false);expect(op['x-required-scopes']).toContain('b2b:documents:read');expect(op.security).toEqual([{B2bBearer:[],PrivateTransport:[]}]);}
    const replay=api.paths['/b2b/v1/webhook-deliveries/{id}/replay'].post;expect(replay.responses['202']).toBeDefined();expect(replay.parameters.find((p:any)=>p.name==='If-Match').description).toContain('SUSCRIPCIÓN');
    expect(api.components.schemas.HookCreate.properties).not.toHaveProperty('url');expect(api.components.schemas.HookSubscription.properties).not.toHaveProperty('signingSecret');
  });
  it('AsyncAPI only claims the local event, not official acceptance or all future event types',()=>{
    const api=b2bWebhookAsyncApiCandidate();expect(api).toEqual(JSON.parse(read('api-contracts/b2b/asyncapi.webhooks.candidate.v1.json')));expect(api['x-runtime-enabled']).toBe(false);expect(api.components.messages.IssuedLocally.payload.properties.eventName.const).toBe('document.issued-locally.v1');
    expect(b2bWebhookCatalog().status).toBe('DESIGN_ONLY_NOT_IMPLEMENTED');
  });
  it('keeps service bases, queues, secrets and public rollout separate',()=>{
    const worker=read('services/webhook-service/src/worker.ts');expect(worker).toContain('factuez-b2b-webhooks-v1');expect(worker).not.toMatch(/sunat-submissions|process\.env|Bearer/);
    const store=read('services/webhook-service/src/store.ts');expect(store).toContain("'b2b_webhooks_beta'");expect(store).not.toContain('CREATE TABLE');
    for(const p of ['docker-compose.yml','infra/kong/kong.stage2.qa.yml','services/billing-service/src/app.module.ts'])expect(read(p)).not.toMatch(/B2bCommitPublisher|WebhookOwnerModule|b2b\/v1\/webhook/);
    const publisher=read('services/billing-service/src/b2b/webhook-publisher.ts');expect(publisher).toContain('fanoutLease');expect(publisher).not.toMatch(/UPDATE "OutboxEvent"|QueueNames/);
  });
});
