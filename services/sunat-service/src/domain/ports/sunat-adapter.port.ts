export type SunatEnvironment = 'BETA' | 'PRODUCTION';

export type SynchronousCdr = {
  kind: 'CDR';
  cdrZip: Buffer;
};

export type AsynchronousTicket = {
  kind: 'TICKET';
  ticket: string;
};

export type SubmissionReceipt = SynchronousCdr | AsynchronousTicket;

export type TicketStatus =
  | { kind: 'PROCESSING' }
  | { kind: 'CDR'; cdrZip: Buffer }
  | { kind: 'ERROR'; code: string; message: string; retryable: boolean };

export interface SignedPackage {
  documentId: string;
  fileName: string;
  zip: Buffer;
  sha256: string;
}

/**
 * Puerto de salida del dominio. El caso de uso no conoce SOAP, REST, WSDL,
 * OAuth ni credenciales. Los adaptadores traducen errores técnicos a errores
 * tipados y nunca cambian el correlativo ni reconstruyen el documento.
 */
export interface SunatSubmissionPort {
  submit(input: SignedPackage): Promise<SubmissionReceipt>;
  getStatus(ticket: string): Promise<TicketStatus>;
}

