import { Phase8AdminOperation, Phase8AdminCapabilities, adminDenied, adminOwnerError, adminPick, adminResult,
  type Phase8AdminAccess, type Phase8AdminAction, type Phase8AdminDependencies
} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { FiscalConfigurationService, type ConfigurationInput } from '../application/fiscal-configuration.service';

/** Owner must be a separate FiscalConfigurationService.createWithOwnerContext instance
 * using exactly this capabilities object. No bearer fallback and no SUNAT transport. */
export class B2bPhase8FiscalAdmin {
  constructor(private readonly deps: Phase8AdminDependencies, private readonly owner?: FiscalConfigurationService,
    private readonly capabilities?: Phase8AdminCapabilities) {}
  async execute(access: Phase8AdminAccess, action: Phase8AdminAction, input: unknown) {
    let op: Phase8AdminOperation|undefined, handle: object|undefined;
    try {
      if (!['FISCAL_READ','FISCAL_AUDIT','FISCAL_SAVE'].includes(action)) return adminDenied(400,'INVALID_ADMIN_ACTION');
      op = await Phase8AdminOperation.open(this.deps,access,action,input);
      if (!this.owner || !this.capabilities) return adminDenied(503,'ADMIN_OWNER_UNAVAILABLE');
      const {binding:b,payload:p,id} = op.input;
      if (id !== undefined || action === 'FISCAL_READ' && Object.keys(p).length ||
        action === 'FISCAL_AUDIT' && (Object.keys(p).join(',') !== 'page' || typeof p.page !== 'string') ||
        action === 'FISCAL_SAVE' && Object.hasOwn(p,'remove')) return adminDenied(400,'INVALID_ADMIN_PAYLOAD');
      handle = this.capabilities.open(op);
      const actor = await op.revalidate();
      let data: unknown;
      if (action === 'FISCAL_AUDIT') {
        const r = await this.owner.audit(String(b.issuerId),'BETA',handle,p.page as string);
        data = {...adminPick(r,['ruc','environment','page','pageSize','total']),
          items:r.items.map(v=>adminPick(v,['id','actorId','fields','revision','occurredAt']))};
      } else {
        const r = action === 'FISCAL_READ' ? await this.owner.status(String(b.issuerId),'BETA',handle)
          : await this.owner.save(String(b.issuerId),'BETA',p as unknown as ConfigurationInput,handle,actor.sub);
        data = {...adminPick(r,['ruc','environment','revision','updatedAt','solConfigured','greConfigured','fiscalTransmission']),
          certificate:adminPick(r.certificate,['configured','fingerprint','expiresAt','selfSigned','expired','trustAndRucVerified'])};
      }
      await op.revalidate(); return adminResult(data);
    } catch (error) { throw adminOwnerError(error); }
    finally { if (handle) this.capabilities!.revoke(handle); op?.close(); }
  }
}

