/** Reception connections are distinct from emission and never present/accept tax books. */
export interface ReceivedAutomationSettings {
  enabled: boolean;
  mode: 'LOCAL_FIXTURE' | 'LIVE_READ_ONLY';
  intervalMinutes: number;
  mailbox: { enabled: boolean; host: string; port: 993; folder: string; username: string };
  sire: { enabled: boolean; startPeriod: string; clientId: string; solUsername: string };
}
export interface ReceivedAutomationSave {
  expectedRevision: number;
  settings: ReceivedAutomationSettings;
  credentials?: { mailPassword?: string; sireClientSecret?: string; solPassword?: string };
}
export interface ReceivedAutomationConfig {
  companyId: number; recipientRuc: string; revision: number; updatedAt: string | null;
  settings: ReceivedAutomationSettings;
  credentials: { mailPassword: boolean; sireClientSecret: boolean; solPassword: boolean };
  liveReadAllowed: boolean; mailHostApproved: boolean; canManage: boolean;
  state: 'DISABLED' | 'READY_LOCAL' | 'WAITING_TI' | 'READY_READ_ONLY'; notice: string;
}
export type ReceivedSyncCounters = { detected: number; imported: number; duplicate: number; rejected: number; xmlPending: number; matches: number; mismatches: number };
export interface ReceivedSyncRun {
  id: string; source: 'MAIL' | 'SIRE'; status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
  startedAt: string | null; finishedAt: string | null; counters: ReceivedSyncCounters; errorCode: string | null;
}
export interface ReceivedSireDiscovery {
  id: string; companyId: number; recipientRuc: string; period: string; supplierRuc: string;
  supplierName: string | null; documentType: string; fullNumber: string; issueDate: string;
  currencyCode: string | null; amount: string | null; xmlStatus: 'PENDING' | 'MATCHED' | 'CONFLICT';
  documentId: string | null; observedAt: string;
}
