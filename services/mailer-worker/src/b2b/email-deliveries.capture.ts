import {createRequire} from 'node:module';
import {emailFail,emailHash} from './email-deliveries';
import type {EmailDeliveryCaptureMessage,EmailDeliveryCaptureTransport} from './email-deliveries.types';
export interface EmailDeliveryLocalCaptureSink {
  /** Owner stores EML only locally; never forwards it or invokes SMTP. */
  writeLocalCapture(value:Readonly<{jobId:string;attemptId:string;sha256:string;eml:Uint8Array}>):Promise<void>;
}
/** Nodemailer's in-memory stream transport has no network configuration or SMTP connection.
 * Explicit LOCAL_CAPTURE opt-in and local sink required; no host/port/auth/user-controlled headers accepted. */
export class NodemailerLocalEmailCapture implements EmailDeliveryCaptureTransport {
  readonly profile='LOCAL_CAPTURE' as const;
  private readonly mailer:{sendMail(value:unknown):Promise<{message:Buffer}>};
  constructor(private readonly sink:EmailDeliveryLocalCaptureSink,profile:'LOCAL_CAPTURE') {
    if(profile!=='LOCAL_CAPTURE'||!sink||typeof sink.writeLocalCapture!=='function')emailFail(503,'EMAIL_CAPTURE_DISABLED');
    const nodemailer=createRequire(__filename)('nodemailer');
    this.mailer=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix',disableFileAccess:true,disableUrlAccess:true});
  }
  async capture(message:EmailDeliveryCaptureMessage):Promise<{state:'CAPTURED_LOCAL'}> {
    const r=await this.mailer.sendMail({from:'FactuEz Local <capture@factuez.invalid>',to:message.recipient,
      subject:'LOCAL BETA - representación de documento',text:'Captura local BETA. No acredita entrega al cliente ni aceptación fiscal.',
      headers:message.headers,messageId:'<'+message.attemptId+'@factuez.invalid>',
      disableFileAccess:true,disableUrlAccess:true,
      attachments:message.attachments.map(a=>({filename:a.fileName,content:Buffer.from(a.bytes),contentType:a.mediaType,
        contentDisposition:'attachment',headers:{'X-Content-Sha256':a.sha256}}))});
    if(!Buffer.isBuffer(r.message)||!r.message.length||r.message.length>32*1024*1024)emailFail(503,'EMAIL_CAPTURE_UNAVAILABLE');
    await this.sink.writeLocalCapture(Object.freeze({jobId:message.jobId,attemptId:message.attemptId,sha256:emailHash(r.message),eml:Buffer.from(r.message)}));
    return {state:'CAPTURED_LOCAL'};
  }
}

