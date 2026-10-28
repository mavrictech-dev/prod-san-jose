import { B2bIdentityError } from './model';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import type { B2bGuideIssueBinding, B2bGuideIssueAction } from '@factuez/contracts/b2b-guide-security';
import { validB2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';

/** Identity asks the owner over fixed private HTTPS; no Billing DB or classes. */
export class HttpGuideIssueCatalogue {
  constructor(private readonly http: { post(path: string, body: unknown): Promise<unknown> }) {}
  async validate(bindings: B2bGuideIssueBinding[], action: B2bGuideIssueAction): Promise<void> {
    if (!['READ', 'ISSUE'].includes(action) || !Array.isArray(bindings) || !bindings.length ||
      bindings.length > 500 || !bindings.every(validB2bGuideIssueBinding)) throw new B2bIdentityError(400, 'INVALID_GUIDE_ISSUE_BINDINGS');
    try {
      const r = await this.http.post('/internal/b2b/validate-guide-issue-bindings', { bindings: structuredClone(bindings), action });
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).join(',') !== 'valid' ||
        Object.getOwnPropertyDescriptor(r, 'valid')?.value !== true) throw new Error();
    } catch (e) {
      if (e instanceof B2bSecurityError && [400, 403, 404].includes(e.status))
        throw new B2bIdentityError(404, 'RESOURCE_NOT_FOUND');
      throw new B2bIdentityError(503, 'GUIDE_ISSUE_CATALOGUE_UNAVAILABLE');
    }
  }
}
