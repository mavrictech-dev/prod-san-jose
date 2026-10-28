/** Liveness and enabled transports only; never claims SMTP readiness or delivery. */
export function mailerHealth(environment: Record<string, string | undefined> = process.env) {
 const corporate = environment.SERVER_SMTP_ENABLED === 'true';
 const documents = corporate && environment.SERVER_SMTP_DOCUMENTS_ENABLED === 'true';
 const local = environment.LOCAL_MAIL_QA_ENABLED === 'true';
 return { status: 'ok', transport: corporate ? 'CORPORATE_SMTP' : local ? 'LOCAL_MAILPIT' : 'DISABLED',
  transports: { corporateSmtp: corporate, corporateDocuments: documents, localCapture: local },
  readiness: 'NOT_PROBED', deliveredToClient: false };
}
