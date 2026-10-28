import { Controller, Inject, Module, Post, Req, Res, UseFilters, type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { BillingBatchHttpErrorFilter } from './batch-member-http';
import { BillingBatchPolicyAdministration } from './batch-policy-administration';
import type { PostgresBatchMemberOwner } from './batch-member-postgres';
const CORE = Symbol('Batch policy command'), PEERS = Symbol('Batch policy administrator peers');
@Controller('internal/b2b')
@UseFilters(BillingBatchHttpErrorFilter)
export class BillingBatchPolicyController {
  constructor(@Inject(CORE) private readonly core: { set(token: string, policy: unknown): Promise<number> }, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('batch-policy') async set(@Req() req: any, @Res() res: any) {
    b2bPrivatePeer(req, this.peers);
    const names = (req.rawHeaders ?? []).filter((_v: unknown, i: number) => i % 2 === 0).map((n: string) => n.toLowerCase());
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header) || names.filter((n:string)=>n==='authorization').length!==1)
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (req.url !== '/internal/b2b/batch-policy' || new Set(names).size !== names.length || req.headers['transfer-encoding'] || req.headers['content-encoding'] ||
        names.some((n:string)=>n.replace(/[-_]/g,'')==='authorization'&&n!=='authorization') ||
        !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '') || !/^[1-9][0-9]{0,4}$/.test(req.headers['content-length'] ?? '') || Number(req.headers['content-length']) > 16384 ||
        !req.body || Object.keys(req.body).join(',') !== 'policy') throw new B2bSecurityError(400, 'INVALID_BATCH_REQUEST');
    const revision = await this.core.set(header.slice(7), req.body.policy);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).json({ schemaVersion: 'factuez.billing.batch-local-policy.v1', revision, environment: 'BETA', fiscalExecutionEnabled: false });
  }
}
@Module({})
export class BillingBatchPolicyModule {
  static isolated(admin: BillingBatchPolicyAdministration, owner: Pick<PostgresBatchMemberOwner, 'setLocalGrant'>, peers: readonly string[]): DynamicModule {
    if (!(admin instanceof BillingBatchPolicyAdministration) || typeof owner?.setLocalGrant !== 'function' || !Array.isArray(peers) || !peers.length ||
        peers.length > 100 || new Set(peers).size !== peers.length || peers.some(p=>!/^[a-f0-9]{64}$/.test(p))) throw Error('BILLING_BATCH_POLICY_CONFIGURATION_REQUIRED');
    return { module: BillingBatchPolicyModule, controllers: [BillingBatchPolicyController], providers: [BillingBatchHttpErrorFilter,
      { provide: CORE, useValue: { set: (token:string, policy:any) => admin.withPolicy(token, policy, (handle, exactPolicy)=>owner.setLocalGrant(handle, exactPolicy)) } },
      { provide: PEERS, useValue: Object.freeze([...peers]) }] };
  }
}
