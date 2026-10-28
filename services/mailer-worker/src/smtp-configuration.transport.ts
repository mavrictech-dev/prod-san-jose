import { Injectable } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { corporateSmtpTransportOptions, EXTERNAL_SMTP_STATE, type CorporateSmtpConfiguration } from './smtp-configuration.policy';

/** Puerto corporativo preparado, pero bloqueado en este incremento: ni verify() ni send() acceden a la red. */
@Injectable()
export class PreparedCorporateSmtp {
  dryRun(config: CorporateSmtpConfiguration) {
    const options = corporateSmtpTransportOptions(config);
    return { state: EXTERNAL_SMTP_STATE, localPolicyValid: true, tlsPolicy: options.secure ? 'TLS_465' : 'STARTTLS_587',
      certificateValidationRequired: true, networkAttempted: false, dnsValidated: false,
      smtpAuthenticationVerified: false, deliveredToClient: false, readyToSend: false } as const;
  }

  async verify(): Promise<never> { throw new AccessError(423, 'Verificación SMTP externa deshabilitada; sólo diagnóstico local'); }
  async send(): Promise<never> { throw new AccessError(423, 'Envío SMTP externo deshabilitado'); }
}
