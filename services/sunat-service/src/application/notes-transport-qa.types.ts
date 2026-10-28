import type { NoteQaArtifact } from './notes-qa.repository';
import { QA_SCENARIOS, type QaScenario } from '../infrastructure/sunat/bounded-soap.adapter';

export const NOTES_TRANSPORT_PROFILE = 'LOCAL-QA-NOTES-TRANSPORT-v1';
export const NOTES_TRANSPORT_LEASE_MS = 60000;
export const NOTES_TRANSPORT_MAX_ATTEMPTS = 3;
export const NOTES_TRANSPORT_MAX_POLLS = 8;
export type NotesTransportState = 'QUEUED' | 'SENDING' | 'WAITING_TICKET' | 'ACCEPTED' | 'OBSERVED' | 'REJECTED' | 'UNKNOWN' | 'BLOCKED';
/** Persistido únicamente en xsdEvidence.transportQa; state SQL sigue SIGNED_LOCAL. */
export type NotesTransportQa = {
  profile: typeof NOTES_TRANSPORT_PROFILE; revision: number; state: NotesTransportState;
  scenario: QaScenario; mode: 'sendBill' | 'sendSummary'; requestFileName: string; reference: string;
  snapshotSha256: string; credentialRevision: number; certificateFingerprint: string;
  attempts: number; polls: number; notBefore: number; leaseUntil: number; fence: string | null;
  ticket: string | null; postStarted: boolean; description: string;
  requestXml?: NoteQaArtifact; requestZip?: NoteQaArtifact; requestXsd?: unknown;
  cdrZip?: NoteQaArtifact; cdrXml?: NoteQaArtifact; responseCode?: string; notes?: string[];
};
export type NotesTransportEvidence = Record<string, unknown> & { transportQa?: NotesTransportQa };
export function transportEvidence(value: unknown): NotesTransportEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evidencia XSD requerida');
  return value as NotesTransportEvidence;
}
export function notesTransport(value: unknown): NotesTransportQa | undefined {
  const evidence = transportEvidence(value); const transport = evidence.transportQa;
  if (transport !== undefined && (!transport || transport.profile !== NOTES_TRANSPORT_PROFILE || !Number.isSafeInteger(transport.revision) || transport.revision < 1 ||
    !['QUEUED', 'SENDING', 'WAITING_TICKET', 'ACCEPTED', 'OBSERVED', 'REJECTED', 'UNKNOWN', 'BLOCKED'].includes(transport.state) ||
    !QA_SCENARIOS.includes(transport.scenario) || !['sendBill', 'sendSummary'].includes(transport.mode) ||
    !Number.isSafeInteger(transport.attempts) || transport.attempts < 0 || transport.attempts > NOTES_TRANSPORT_MAX_ATTEMPTS ||
    !Number.isSafeInteger(transport.polls) || transport.polls < 0 || transport.polls > NOTES_TRANSPORT_MAX_POLLS ||
    !Number.isSafeInteger(transport.notBefore) || transport.notBefore < 0 || !Number.isSafeInteger(transport.leaseUntil) || transport.leaseUntil < 0 ||
    typeof transport.postStarted !== 'boolean' || (transport.ticket !== null && (typeof transport.ticket !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(transport.ticket))) ||
    (transport.fence !== null && (typeof transport.fence !== 'string' || !/^[0-9a-f-]{36}$/i.test(transport.fence))) ||
    (transport.state === 'WAITING_TICKET' && (!transport.ticket || !transport.postStarted)) || (transport.state === 'QUEUED' && (transport.postStarted || transport.ticket)))) throw new Error('Evidencia de transporte incompatible');
  return transport;
}
