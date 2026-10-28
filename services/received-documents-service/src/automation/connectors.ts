import { ImapFlow } from 'imapflow';
import { mailboxOptions, visitMailbox } from './mailbox';
import { SireReadClient, type SireCredentials } from './sire-client';
import type { ReceivedAutomationSettings } from '@factuez/contracts';
export type ReceptionConnectors = {
  sire(credentials: SireCredentials): SireReadClient;
  mailbox: typeof visitMailbox;
  validateMailbox(settings: ReceivedAutomationSettings['mailbox'], password: string): Promise<void>;
};
export const productionConnectors: ReceptionConnectors = {
  sire: credentials => new SireReadClient(credentials, { liveAllowed: process.env.RECEIVED_LIVE_READ_ALLOWED === 'true' }),
  mailbox: visitMailbox,
  async validateMailbox(settings, password) {
    const client = new ImapFlow(mailboxOptions(settings, password, process.env.RECEIVED_LIVE_READ_ALLOWED === 'true'));
    client.on('error', () => {});
    const timer = setTimeout(() => client.close(), 30000);
    try { await client.connect(); const lock = await client.getMailboxLock(settings.folder, { readOnly: true }); lock.release(); }
    finally { clearTimeout(timer); client.close(); }
  },
};
