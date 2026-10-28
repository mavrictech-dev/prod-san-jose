import { publicLookup } from './network';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { AccessError } from '@factuez/service-access';
import { createHash } from 'node:crypto';
import type { ReceivedAutomationSettings } from '@factuez/contracts';
import { imapApproved, imapHost } from './policy';
import { safeArtifactName } from '../validation';

export const MAX_MAIL_BYTES = 16 * 1024 * 1024;
export type MailAttachment = { fileName: string; bytes: Buffer };
export type MailMessage = { uid: number; uidValidity: string; raw: Buffer | null; errorCode?: string };
export function mailboxFingerprint(m: ReceivedAutomationSettings['mailbox']) { return createHash('sha256').update(JSON.stringify([m.host, m.port, m.username, m.folder])).digest('hex'); }
export async function mailAttachments(raw: Uint8Array): Promise<MailAttachment[]> {
  if (!raw.byteLength || raw.byteLength > MAX_MAIL_BYTES) throw new AccessError(400, 'MAIL_TOO_LARGE');
  // Bodies are neither rendered nor saved; never follow links/URLs in messages.
  const message = await simpleParser(Buffer.from(raw), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true, maxHtmlLengthToParse: 100000 });
  const attachments = message.attachments.filter(a => a.filename && /\.(xml|zip|pdf)$/i.test(a.filename));
  if (attachments.length > 10 || attachments.reduce((n, a) => n + a.content.length, 0) > 12 * 1024 * 1024) throw new AccessError(400, 'MAIL_ATTACHMENT_LIMIT');
  return attachments.map(a => {
    if (!a.content.length || a.content.length > 4 * 1024 * 1024) throw new AccessError(400, 'MAIL_ATTACHMENT_LIMIT');
    return { fileName: safeArtifactName(a.filename), bytes: a.content };
  });
}
export function mailboxOptions(m: ReceivedAutomationSettings['mailbox'], password: string, liveAllowed = false,
  approvedHosts?: readonly string[]) {
  const approved = approvedHosts === undefined ? imapApproved(m.host) :
    Array.isArray(approvedHosts) && approvedHosts.length <= 16 && approvedHosts.every(h => imapHost(h)) && approvedHosts.includes(m.host);
  if (!liveAllowed || !approved || m.port !== 993 || !m.username || !password) throw new AccessError(403, 'MAIL_READ_NOT_AUTHORIZED');
  return { host: m.host, port: 993, secure: true, auth: { user: m.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, servername: m.host, lookup: publicLookup },
    logger: false as const, emitLogs: false, logRaw: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    maxLineLength: 65536, maxLiteralSize: MAX_MAIL_BYTES, maxResponseSize: MAX_MAIL_BYTES + 65536 };
}
/** EXAMINE/PEEK only: no Seen flag, delete, move or expunge. UIDVALIDITY handles mailbox rebuilds. */
export async function visitMailbox(m: ReceivedAutomationSettings['mailbox'], password: string,
  checkpoint: { uidValidity: string; lastUid: bigint } | null,
  consume: (message: MailMessage) => Promise<void>, liveAllowed = false,
  factory: (options: ReturnType<typeof mailboxOptions>) => ImapFlow = options => new ImapFlow(options),
  approvedHosts?: readonly string[], limits: { maxMessages?: number } = {}) {
  const maxMessages = limits.maxMessages ?? 50;
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 50) throw new AccessError(400, 'MAILBOX_BATCH_INVALID');
  const client = factory(mailboxOptions(m, password, liveAllowed, approvedHosts));
  client.on('error', () => {});
  const deadline = setTimeout(() => client.close(), 90000);
  try {
    await client.connect(); const lock = await client.getMailboxLock(m.folder, { readOnly: true });
    try {
      const box = client.mailbox; if (!box) throw new AccessError(503, 'MAILBOX_UNAVAILABLE');
      const uidValidity = String(box.uidValidity), uidNext = Number(box.uidNext);
      if (!/^\d{1,20}$/.test(uidValidity) || !Number.isSafeInteger(uidNext) || uidNext < 1 || uidNext > 4294967296) throw new AccessError(503, 'MAILBOX_CURSOR_INVALID');
      const before = checkpoint?.uidValidity === uidValidity ? Number(checkpoint.lastUid) : 0;
      if (!Number.isSafeInteger(before) || before < 0 || before > 4294967295) throw new AccessError(503, 'MAILBOX_CURSOR_INVALID');
      if (before >= uidNext - 1) return { uidValidity, lastUid: before };
      const scanEnd = Math.min(uidNext - 1, before + 1000);
      const metadata = (await client.fetchAll(`${before + 1}:${scanEnd}`, { uid: true, size: true }, { uid: true })).filter(v => v.uid > before && v.uid <= scanEnd).sort((a, b) => a.uid - b.uid);
      if (metadata.length > 1000) throw new AccessError(503, 'MAILBOX_BATCH_INVALID');
      let lastUid = before;
      for (const meta of metadata.slice(0, maxMessages)) {
        if (typeof meta.size !== 'number' || !Number.isInteger(meta.size) || meta.size <= 0 || meta.size > MAX_MAIL_BYTES) {
          await consume({ uid: meta.uid, uidValidity, raw: null, errorCode: 'MAIL_TOO_LARGE' }); lastUid = meta.uid; continue;
        }
        const download = await client.download(String(meta.uid), undefined, { uid: true, maxBytes: MAX_MAIL_BYTES });
        if (!download?.content) throw new AccessError(503, 'MAIL_MESSAGE_UNAVAILABLE');
        const chunks: Buffer[] = []; let size = 0;
        for await (const part of download.content) { const bytes = Buffer.from(part); size += bytes.length; if (size > MAX_MAIL_BYTES) { download.content.destroy(); throw new AccessError(503, 'MAIL_DOWNLOAD_LIMIT'); } chunks.push(bytes); }
        if (size !== meta.size) throw new AccessError(503, 'MAIL_DOWNLOAD_INCOMPLETE');
        const raw = Buffer.concat(chunks);
        try { await consume({ uid: meta.uid, uidValidity, raw }); } finally { raw.fill(0); }
        lastUid = meta.uid;
      }
      if (metadata.length <= maxMessages) lastUid = scanEnd; // Safely advance over UID gaps/deleted messages.
      return { uidValidity, lastUid };
    } finally { lock.release(); }
  } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError(503, 'MAIL_CONNECTION_FAILED'); }
  finally { clearTimeout(deadline); client.close(); }
}
