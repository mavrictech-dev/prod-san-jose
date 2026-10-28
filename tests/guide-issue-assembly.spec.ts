import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCandidateGuideIssueProducer } from '../services/billing-service/src/b2b/guide-issue-assembly';
import { guideIssueFixture } from './helpers/guide-issue.fixture';

describe('explicit guide issue composition', () => {
  it('constructs without queries, authorization, schema work or workers', () => {
    const database = { $transaction: vi.fn(async () => { throw new Error('DATABASE_MUST_NOT_BE_CALLED'); }) };
    const authority = { current: vi.fn(async () => { throw new Error('AUTHORITY_MUST_NOT_BE_CALLED'); }) };
    expect(createCandidateGuideIssueProducer({ database, authority, allowedRucs: [] })).toBeDefined();
    expect(database.$transaction).not.toHaveBeenCalled(); expect(authority.current).not.toHaveBeenCalled();
  });
  it('empty allowlist does not reach SQL even when external authority grants the pair', async () => {
    const f = guideIssueFixture(), database = { $transaction: vi.fn(async () => { throw new Error('DATABASE_MUST_NOT_BE_CALLED'); }) };
    const core = createCandidateGuideIssueProducer({ database, authority: f.authority, allowedRucs: [] });
    await expect(core.issue('synthetic', 'SERVICE', f.request)).rejects.toMatchObject({ code: 'GUIDE_ISSUE_ISSUER_NOT_ENABLED' });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
  it('neither wires official transport nor silently registers an activation path', () => {
    const source = readFileSync(new URL('../services/billing-service/src/b2b/guide-issue-assembly.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/SunatGreRestAdapter|fetch\(|axios|process\.env|new Worker|@Controller|app\.listen/);
    expect(source).toContain('authority: GuideIssueAuthority');
    expect(source).toContain('allowedRucs: readonly string[]');
  });
});
