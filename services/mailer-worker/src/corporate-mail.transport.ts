import { Injectable } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { createRequire } from 'node:module';
import type { SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { smtpMailbox, type CorporateSmtpConfiguration } from './smtp-configuration.policy';
import { pinnedSmtpOptions, smtpDiagnosticNetwork, withSmtpDeadline, type SmtpDiagnosticNetwork } from './smtp-live-diagnostic';
import { corporateSmtpEnabled, corporateDisabled } from './corporate-mail.policy';
export interface CorporateTestMailer {
  sendMail(message: SendMailOptions): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[]; pending?: unknown[]; response: string }>;
  close(): void;
}
export interface CorporateTestNetwork extends Pick<SmtpDiagnosticNetwork, 'resolve' | 'connect'> {
  createTransport(options: SMTPTransport.Options): CorporateTestMailer;
}
const network: CorporateTestNetwork = { resolve: smtpDiagnosticNetwork.resolve, connect: smtpDiagnosticNetwork.connect,
  createTransport: options => createRequire(__filename)('nodemailer').createTransport(options) };
@Injectable()
export class CorporateMailSmtp {
  constructor(private readonly io: CorporateTestNetwork = network) {}
  async send(config: CorporateSmtpConfiguration, recipient: string, id: string, current: () => Promise<void>, submitting: () => Promise<void>) {
    if (!smtpMailbox(recipient)) throw new AccessError(400, 'Destinatario de prueba inválido');
    return withSmtpDeadline(async scope => {
      await scope.step(current);
      const options = await pinnedSmtpOptions(config, current, scope, this.io);
      await scope.step(current); // DNS/preparation completed; authorization precedes the transport factory.
      const mailer = this.io.createTransport(options); scope.cleanup(() => mailer.close());
      const messageId = '<factuez-test-' + id + '@delivery.factuez.invalid>';
      const message: SendMailOptions = {
        from: { name: config.fromName, address: config.fromAddress }, to: recipient,
        ...(config.replyTo ? { replyTo: config.replyTo } : {}), envelope: { from: config.fromAddress, to: [recipient] },
        messageId, subject: 'Prueba de correo corporativo · FactuEz',
        text: 'Prueba solicitada expresamente desde el panel de correo de FactuEz. Sin adjuntos ni documentos tributarios. La aceptación SMTP no confirma la entrega al destinatario.',
        disableFileAccess: true, disableUrlAccess: true,
      };
      await scope.step(current); // Reauthorization after preparing the exact immutable message.
      await scope.step(submitting); // Durable SENDING before crossing the SMTP ambiguity boundary.
      try {
        const result = await scope.step(() => mailer.sendMail(message));
        if (result.messageId !== messageId || result.accepted?.length !== 1 || result.accepted[0] !== recipient ||
          !Array.isArray(result.rejected) || result.rejected.length || result.pending?.length || !/^250(?:[ -]|$)/.test(result.response))
          throw new Error();
      } catch { throw new AccessError(503, 'Resultado SMTP incierto; no se reintentará automáticamente'); }
      return { handedOffToSmtp: true, deliveredToClient: false } as const;
    }, () => { if (!corporateSmtpEnabled()) throw corporateDisabled(); });
  }
}
