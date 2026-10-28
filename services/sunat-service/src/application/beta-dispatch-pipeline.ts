import { createHash } from 'node:crypto';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { SubmissionReceipt, TicketStatus } from '../domain/ports/sunat-adapter.port';
import { SoapSubmissionError } from '../infrastructure/sunat/bounded-soap.adapter';
import { isRetryableLocalPreparationError } from './local-preparation-policy';

export type BetaPhase = 'AWAITING_AUTHORIZATION' | 'PREPARING' | 'PREPARED' | 'RETRY_PREPARATION' |
  'SENDING' | 'WAITING_TICKET' | 'POLLING' | 'DONE' | 'UNKNOWN' | 'BLOCKED' | 'CDR_UNVERIFIED';
export type BetaDispatchContext = { environment?: 'BETA' | 'PRODUCTION'; documentTypeCode: string; issuer: { identityNumber: string } };
export type BetaDispatchRow<T extends BetaDispatchContext = FiscalDocumentSnapshot> = { id: string; documentId: string; phase: BetaPhase; attempt: number; owner: Date;
  snapshot: T; ticket: string | null };
export type BetaPrepared = { fileName: string; zip: Buffer; sha256: string; reference: string; revision: number };
export type BetaCdr = { trusted: boolean; status: 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED';
  code: string; description: string; notes: string[];
  receiptSummary?: { summaryIdentifier: string; summaryXmlSha256: string; summaryZipSha256: string; documentSnapshotSha256: string } };
/** Puertos internos: ni HTTP del cliente ni un booleano del formulario autorizan esta ejecución. */
export interface BetaDispatchPorts<T extends BetaDispatchContext = FiscalDocumentSnapshot> {
  authorize(row: BetaDispatchRow<T>): Promise<void>;
  claim(row: BetaDispatchRow<T>, phase: 'PREPARING' | 'POLLING'): Promise<BetaDispatchRow<T> | null>;
  prepare(row: BetaDispatchRow<T>): Promise<BetaPrepared>;
  archived(row: BetaDispatchRow<T>): Promise<BetaPrepared>;
  savePrepared(row: BetaDispatchRow<T>, prepared: BetaPrepared): Promise<boolean>;
  owns(row: BetaDispatchRow<T>, phase: BetaPhase): Promise<boolean>;
  transition(row: BetaDispatchRow<T>, from: BetaPhase, to: BetaPhase,
    details?: { ticket?: string; code?: string; delayMs?: number; cdr?: BetaCdr }): Promise<boolean>;
  submit(row: BetaDispatchRow<T>, prepared: BetaPrepared): Promise<SubmissionReceipt>;
  getStatus(row: BetaDispatchRow<T>, ticket: string): Promise<TicketStatus>;
  cdr(row: BetaDispatchRow<T>, prepared: BetaPrepared, bytes: Buffer): Promise<BetaCdr>;
}

/** Vertical compartida, verificada con puertos ficticios. Cada ambiente exige su autorización privada. */
export class BetaDispatchPipeline<T extends BetaDispatchContext = FiscalDocumentSnapshot> {
  constructor(private readonly ports: BetaDispatchPorts<T>, private readonly environment: 'BETA' | 'PRODUCTION' = 'BETA') {}
  async run(input: BetaDispatchRow<T>) {
    if (input.snapshot.environment !== this.environment || !(this.environment === 'BETA' ? ['01', '03', '07', '08', 'RC', 'RA'] : ['01', '03']).includes(input.snapshot.documentTypeCode))
      throw new Error(this.environment === 'BETA' ? 'Sólo 01/03/07/08/RC/RA BETA; producción no tiene ruta Beta' : 'Documento fuera del perfil de despacho de producción autorizado');
    if (!['AWAITING_AUTHORIZATION', 'RETRY_PREPARATION', 'PREPARED', 'WAITING_TICKET'].includes(input.phase)) return;
    // Antes de leer una clave o artefacto, y otra vez inmediatamente antes de cada llamada externa.
    await this.ports.authorize(input);
    const polling = input.phase === 'WAITING_TICKET';
    const row = await this.ports.claim(input, polling ? 'POLLING' : 'PREPARING'); if (!row) return;
    let phase: BetaPhase = polling ? 'POLLING' : 'PREPARING'; let attemptedPost = false;
    try {
      const prepared = polling || input.phase === 'PREPARED' ? await this.ports.archived(row) : await this.ports.prepare(row);
      if (createHash('sha256').update(prepared.zip).digest('hex') !== prepared.sha256 ||
        !prepared.fileName.startsWith(`${row.snapshot.issuer.identityNumber}-`)) throw new Error('Paquete archivado inconsistente');
      if (!await this.ports.owns(row, phase)) return;
      if (!polling) {
        if (!await this.ports.savePrepared(row, prepared)) return; phase = 'PREPARED';
        await this.ports.authorize(row);
        if (!await this.ports.transition(row, phase, 'SENDING')) return; phase = 'SENDING';
      } else {
        if (!row.ticket) throw new Error('Ticket archivado ausente');
        await this.ports.authorize(row);
      }
      if (!await this.ports.owns(row, phase)) return;
      attemptedPost = true;
      const result = polling ? await this.ports.getStatus(row, row.ticket!) : await this.ports.submit(row, prepared);
      if (result.kind === 'TICKET') {
        await this.ports.transition(row, phase, 'WAITING_TICKET', { ticket: result.ticket, delayMs: 2000 }); return;
      }
      if (result.kind === 'PROCESSING') {
        await this.ports.transition(row, phase, row.attempt >= 20 ? 'UNKNOWN' : 'WAITING_TICKET',
          { code: row.attempt >= 20 ? 'POLL_LIMIT' : 'PROCESSING', delayMs: Math.min(60000, 2000 * row.attempt) }); return;
      }
      if (result.kind === 'ERROR') {
        await this.ports.transition(row, phase, 'UNKNOWN', { code: result.code }); return;
      }
      if (!await this.ports.owns(row, phase)) return;
      const cdr = await this.ports.cdr(row, prepared, result.cdrZip);
      await this.ports.transition(row, phase, cdr.trusted ? 'DONE' : 'CDR_UNVERIFIED', { cdr,
        code: cdr.trusted ? cdr.code : 'CDR_SIGNATURE_UNVERIFIED' });
    } catch (error) {
      // Una respuesta perdida, CDR inválido o caída posterior al POST nunca crea un segundo envío.
      const business = error instanceof SoapSubmissionError && error.kind === 'BUSINESS';
      const retry = !attemptedPost && isRetryableLocalPreparationError(error) && row.attempt < 3;
      await this.ports.transition(row, phase, retry ? 'RETRY_PREPARATION' : attemptedPost && !business ? 'UNKNOWN' : 'BLOCKED',
        { code: retry ? 'LOCAL_PREPARATION_BUSY' : business ? error.code : attemptedPost ? 'RECONCILIATION_REQUIRED' : 'LOCAL_PREFLIGHT_FAILED',
          ...(retry ? { delayMs: 2000 * 2 ** (row.attempt - 1) } : {}) });
    }
  }
}
