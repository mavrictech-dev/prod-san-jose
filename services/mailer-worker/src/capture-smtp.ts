import { Injectable } from '@nestjs/common';
import nodemailer, { type SendMailOptions } from 'nodemailer';

export const LOCAL_CAPTURE_SMTP_OPTIONS = Object.freeze({ host: 'mailpit', port: 1025, secure: false, ignoreTLS: true,
  connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000, disableFileAccess: true, disableUrlAccess: true });
/** Puerto de salida exclusivo del capturador QA, sustituible en pruebas sin red. */
@Injectable()
export class LocalCaptureSmtp {
  async capture(message: SendMailOptions): Promise<{ messageId: string }> {
    return nodemailer.createTransport(LOCAL_CAPTURE_SMTP_OPTIONS).sendMail(message);
  }
}
