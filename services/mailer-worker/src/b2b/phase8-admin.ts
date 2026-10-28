import { Phase8AdminOperation, Phase8AdminCapabilities, adminDenied, adminOwnerError, adminPick, adminResult,
  type Phase8AdminAccess, type Phase8AdminAction, type Phase8AdminDependencies
} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { SmtpConfigurationService } from '../smtp-configuration.service';
import {openMailerSmtpOwnerCapability,revokeMailerSmtpOwnerCapability} from './host-smtp.context';

/** Only prepared local configuration. No verify/sendMail/DNS/network operations. */
export class B2bPhase8SmtpAdmin {
  constructor(private readonly deps: Phase8AdminDependencies, private readonly owner?: SmtpConfigurationService,
    private readonly capabilities?: Phase8AdminCapabilities) {}
  async execute(access: Phase8AdminAccess, action: Phase8AdminAction, input: unknown) {
    let op: Phase8AdminOperation|undefined, handle: object|undefined;
    try {
      if (!['SMTP_READ','SMTP_SAVE'].includes(action)) return adminDenied(400,'INVALID_ADMIN_ACTION');
      op = await Phase8AdminOperation.open(this.deps,access,action,input);
      if (!this.owner || !this.capabilities) return adminDenied(503,'ADMIN_OWNER_UNAVAILABLE');
      const {binding:b,payload:p,id} = op.input;
      if (id !== undefined || action === 'SMTP_READ' && Object.keys(p).length) return adminDenied(400,'INVALID_ADMIN_PAYLOAD');
      handle = openMailerSmtpOwnerCapability(this.capabilities,op);
      const r = action === 'SMTP_READ' ? await this.owner.status(String(b.issuerId),handle)
        : await this.owner.save(String(b.issuerId),p,handle);
      // Settings, usernames, passwords, ciphertext and key versions never leave this boundary.
      const data = adminPick(r,['companyId','ruc','state','revision','updatedAt','configured','credentialsConfigured',
        'storageReady','encryption','integrity','approvedHostListConfigured','hostnameApproved',
        'networkAttempted','dnsValidated','smtpAuthenticationVerified','deliveredToClient','readyToSend']);
      await op.revalidate(); return adminResult(data);
    } catch (error) { throw adminOwnerError(error); }
    finally { if (handle) revokeMailerSmtpOwnerCapability(this.capabilities!,handle); op?.close(); }
  }
}

