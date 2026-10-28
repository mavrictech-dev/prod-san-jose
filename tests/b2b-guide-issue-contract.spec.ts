import { describe, expect, it } from 'vitest';
import { b2bCandidateOpenApiV1 } from '../packages/contracts/src/b2b-read-openapi';
import { validB2bGuideIssueBinding, b2bGuideIssueBindingKey } from '../packages/contracts/src/b2b-guide-security';
import { B2bPhase2Scopes } from '../packages/contracts/src/b2b-security';
import { guideIssueFixture } from './helpers/guide-issue.fixture';

describe('independent guide issue contract', () => {
  it('requires three distinct series without widening default scopes', () => {
    const f = guideIssueFixture(); expect(validB2bGuideIssueBinding(f.binding)).toBe(true);
    for (const id of [f.binding.draft.anchor.seriesId, f.binding.draft.guideSeriesId])
      expect(validB2bGuideIssueBinding({ ...f.binding, fiscalSeriesId: id })).toBe(false);
    expect(validB2bGuideIssueBinding({ ...f.binding, extra: true })).toBe(false);
    expect(B2bPhase2Scopes).not.toContain('b2b:guides:issue');
    expect(b2bGuideIssueBindingKey(f.binding)).not.toBe(b2bGuideIssueBindingKey({ ...f.binding, fiscalSeriesId: '00000000-0000-4000-8000-000000000999' }));
  });
  it('does not inspect accessor or proxy binding payloads', () => {
    let accessed = false;
    expect(validB2bGuideIssueBinding({ get draft() { accessed = true; throw new Error(); }, fiscalSeriesId: 'invalid' })).toBe(false);
    expect(validB2bGuideIssueBinding(new Proxy({}, { ownKeys() { accessed = true; throw new Error(); } }))).toBe(false);
    expect(accessed).toBe(false);
  });
  it('documents two unmounted, separately scoped operations', () => {
    const api = b2bCandidateOpenApiV1(), issue = api.paths['/b2b/v1/guide-drafts/{id}/issuance'].post,
      read = api.paths['/b2b/v1/guide-drafts/{id}/issuances/{operationId}'].get;
    expect(issue['x-required-scopes']).toContain('b2b:guides:issue');
    expect(read['x-required-scopes']).toContain('b2b:guide-operations:read');
    for (const op of [issue, read]) { expect(op['x-runtime-enabled']).toBe(false); expect(op['x-candidate-only']).toBe(true);
      expect(op.security).toEqual([{ B2bBearer: [], PrivateTransport: [] }]); }
    expect(issue.parameters.some((p: any) => p.name === 'If-Match' && p.required)).toBe(true);
    expect(issue.parameters.some((p: any) => p.name === 'Idempotency-Key' && p.required)).toBe(true);
    expect(read.requestBody).toBeUndefined(); expect(read.parameters.filter((p: any) => p.in === 'query')).toHaveLength(10);
  });
  it('all OpenAPI schema references resolve inside the candidate contract', () => {
    const api = b2bCandidateOpenApiV1(); const visit = (v: any) => {
      if (!v || typeof v !== 'object') return;
      if (typeof v.$ref === 'string' && v.$ref.startsWith('#/components/schemas/'))
        expect(api.components.schemas[v.$ref.slice('#/components/schemas/'.length)], v.$ref).toBeDefined();
      Object.values(v).forEach(visit);
    }; visit(api);
  });
});
