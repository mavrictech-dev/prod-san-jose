import { Injectable } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { createRequire } from 'node:module';
import type { SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { smtpMailbox, type CorporateSmtpConfiguration } from './smtp-configuration.policy';
import { pinnedSmtpOptions, smtpDiagnosticNetwork, withSmtpDeadline, type SmtpDiagnosticNetwork } from './smtp-live-diagnostic';
import { documentGate } from './corporate-document-policy';
import { bytesDigest } from './corporate-document-policy';
import type { PreparedDocument } from './corporate-document-source';
export interface CorporateDocumentMailer {
  sendMail(message: SendMailOptions): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[]; pending?: unknown[]; response: string }>;
  close(): void;
}
export interface CorporateDocumentNetwork extends Pick<SmtpDiagnosticNetwork, 'resolve' | 'connect'> {
  createTransport(options: SMTPTransport.Options): CorporateDocumentMailer;
}
const network: CorporateDocumentNetwork = { resolve: smtpDiagnosticNetwork.resolve, connect: smtpDiagnosticNetwork.connect,
  createTransport: options => createRequire(__filename)('nodemailer').createTransport(options) };
@Injectable()
export class CorporateDocumentSmtp {
  constructor(private readonly io: CorporateDocumentNetwork = network) {}
  async send(config: CorporateSmtpConfiguration, recipient: string, id: string, prepared: PreparedDocument, current: () => Promise<void>, submitting: () => Promise<void>) {
    if (!prepared || prepared.attachments?.length !== 5 || prepared.attachments.some(a => !Buffer.isBuffer(a.content) || bytesDigest(a.content) !== a.sha256)) throw new AccessError(409, 'Adjuntos documentales no verificables');
    if (!smtpMailbox(recipient)) throw new AccessError(400, 'Destinatario documental inválido');
    return withSmtpDeadline(async scope => {
      await scope.step(current);
      const options = await pinnedSmtpOptions(config, current, scope, this.io);
      await scope.step(current); // DNS/preparation completed; authorization precedes the transport factory.
      const mailer = this.io.createTransport(options); scope.cleanup(() => mailer.close());
      const messageId = '<factuez-document-' + id + '@delivery.factuez.invalid>';
      const message: SendMailOptions = {
        from: { name: config.fromName, address: config.fromAddress }, to: recipient,
        ...(config.replyTo ? { replyTo: config.replyTo } : {}), envelope: { from: config.fromAddress, to: [recipient] },
        messageId, subject: 'Comprobante ' + prepared.proof.fullNumber,
        text: 'Se adjunta la representación PDF actual y los archivos XML, ZIP y CDR originales del comprobante ' + prepared.proof.fullNumber + '. Para boletas, el ZIP y CDR corresponden al resumen RC vinculado. La aceptación SMTP no confirma la entrega al destinatario.',
        attachments: prepared.attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType, contentDisposition: 'attachment' as const })),
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
    }, documentGate);
  }
}
