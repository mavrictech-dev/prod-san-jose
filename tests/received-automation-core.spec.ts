import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ReceivedAutomationSettings } from '../packages/contracts/src/received-automation';

const guards = vi.hoisted(() => ({
  imap: vi.fn(function () { throw new Error('ACTUAL_IMAP_FORBIDDEN_IN_QA'); }),
  openSync: vi.fn(), fstatSync: vi.fn(), readSync: vi.fn(), closeSync: vi.fn(),
}));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  openSync: guards.openSync, fstatSync: guards.fstatSync, readSync: guards.readSync, closeSync: guards.closeSync,
}));
// Resolve the service's installed dependency; never instantiate a real socket client.
vi.mock('../services/received-documents-service/node_modules/imapflow', () => ({ ImapFlow: guards.imap }));
// Exercise source without generating dist files outside this test-only write set.
vi.mock('@factuez/received-core', async () => import('../packages/received-core/src/index'));

import { AccessError } from '../packages/service-access/src/index';
import {
  defaultReceptionSettings, emptyCounters, fiscalAmountsMatch, imapApproved, imapHost,
  parseAutomationSave, receptionPeriods, receptionReadiness, validPeriod,
} from '../services/received-documents-service/src/automation/policy';
import { ReceptionVault, type ReceptionSecretContext } from '../services/received-documents-service/src/automation/vault';
import {
  MAX_MAIL_BYTES, mailAttachments, mailboxFingerprint, mailboxOptions, visitMailbox,
  type MailAttachment, type MailMessage,
} from '../services/received-documents-service/src/automation/mailbox';
import { fixtureMail } from '../services/received-documents-service/src/automation/mail-fixture';
import { importPreparedMail, prepareMailDocuments } from '../services/received-documents-service/src/automation/importer';

const ruc = '00000000101', otherRuc = '00000000202', period = '202610';
const host = 'imap.qa.example.com', fakePassword = 'FICTITIOUS-QA-PASSWORD';
const fakeKeyPath = resolve('QA-MOCK-ONLY-NO-FILE', 'reception-key');
const syntheticSecrets = { mailPassword: fakePassword, sireClientSecret: 'FAKE-SIRE-SECRET', solPassword: 'FAKE-SOL-PASSWORD' };
let keyText = Buffer.alloc(32, 0x11).toString('hex');

function settings(): ReceivedAutomationSettings {
  return { enabled: true, mode: 'LIVE_READ_ONLY', intervalMinutes: 15,
    mailbox: { enabled: true, host, port: 993, folder: 'INBOX', username: 'FICTITIOUS-USER' },
    sire: { enabled: true, startPeriod: period, clientId: 'fixture-client', solUsername: 'FAKEUSER' } };
}
const saveInput = () => ({ expectedRevision: 1, settings: settings(), credentials: { ...syntheticSecrets } });
function accessFailure(action: () => unknown, status: number, message?: string) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AccessError);
  expect(failure).toMatchObject({ status, ...(message ? { message } : {}) });
}
function mime(attachments: MailAttachment[], html = '<a href="https://unvisited.invalid/private">Do not follow</a>'): Buffer {
  const boundary = 'factuez-test-only-boundary';
  const parts = attachments.map(a => `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${a.fileName}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.bytes.toString('base64')}\r\n`);
  return Buffer.from(`From: nobody@qa.invalid\r\nTo: foreign@qa.invalid\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/html\r\n\r\n${html}\r\n${parts.join('')}--${boundary}--\r\n`);
}
const mailXml = async () => (await mailAttachments(fixtureMail(ruc, period)))[0];
type VisitFactory = NonNullable<Parameters<typeof visitMailbox>[5]>;
type Meta = { uid: number; size?: number };
function fakeImap(options: { uidValidity?: string | bigint; uidNext?: number; meta?: Meta[]; bytes?: Buffer; mailbox?: false } = {}) {
  const release = vi.fn(), close = vi.fn(), consume = vi.fn<(message: MailMessage) => Promise<void>>(async () => {});
  const client = {
    on: vi.fn(), connect: vi.fn(async () => {}), close,
    mailbox: options.mailbox === false ? false : { uidValidity: options.uidValidity ?? 91n, uidNext: options.uidNext ?? 2 },
    getMailboxLock: vi.fn(async (_folder: string, _options: unknown) => ({ release })),
    fetchAll: vi.fn(async (_range: string, _query: unknown, _options: unknown) => options.meta ?? [{ uid: 1, size: 3 }]),
    download: vi.fn(async (_uid: string, _part: undefined, _options: unknown): Promise<{ content: Readable } | undefined> => ({ content: Readable.from([Buffer.from(options.bytes ?? 'ABC')]) })),
    messageFlagsAdd: vi.fn(() => { throw new Error('IMAP_WRITE_FORBIDDEN'); }),
    messageFlagsSet: vi.fn(() => { throw new Error('IMAP_WRITE_FORBIDDEN'); }),
    messageDelete: vi.fn(() => { throw new Error('IMAP_WRITE_FORBIDDEN'); }),
    messageMove: vi.fn(() => { throw new Error('IMAP_WRITE_FORBIDDEN'); }),
    append: vi.fn(() => { throw new Error('IMAP_WRITE_FORBIDDEN'); }),
    expunge: vi.fn(() => { throw new Error('IMAP_WRITE_FORBIDDEN'); }),
  };
  const factory = vi.fn((_options: unknown) => client) as unknown as VisitFactory;
  return { client, factory, release, close, consume,
    visit: (checkpoint: Parameters<typeof visitMailbox>[2] = null, handler = consume) => visitMailbox(settings().mailbox, fakePassword, checkpoint, handler, true, factory),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('RECEIVED_IMAP_APPROVED_HOSTS', host);
  vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED', 'false');
  vi.stubEnv('RECEIVED_LOCAL_FIXTURE_ENABLED', 'false');
  vi.stubEnv('RECEIVED_QA_USE_APP_KEY', 'false');
  vi.stubEnv('RECEIVED_SETTINGS_KEY_FILE', fakeKeyPath);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('ACTUAL_NETWORK_FORBIDDEN_IN_QA'); }));
  keyText = Buffer.alloc(32, 0x11).toString('hex');
  guards.openSync.mockReset().mockImplementation((path: string) => { expect(path).toBe(fakeKeyPath); return 731; });
  guards.fstatSync.mockReset().mockImplementation(() => ({ isFile: () => true, size: Buffer.byteLength(keyText), mode: 0o100600 }));
  guards.readSync.mockReset().mockImplementation((_fd: number, data: Buffer, offset: number, length: number) => Buffer.from(keyText).copy(data, offset, 0, length));
  guards.closeSync.mockReset();
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); expect(guards.imap).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('automation policy gates and strict validation', () => {
  it('starts disabled with connectors disabled and independent zero counters', () => {
    expect(defaultReceptionSettings(new Date('2026-10-15T12:00:00Z'))).toMatchObject({ enabled: false, mode: 'LIVE_READ_ONLY', intervalMinutes: 15,
      mailbox: { enabled: false, port: 993, folder: 'INBOX', host: '', username: '' }, sire: { enabled: false, startPeriod: period, clientId: '', solUsername: '' } });
    const counters = emptyCounters(); counters.imported = 1;
    expect(emptyCounters()).toEqual({ detected: 0, imported: 0, duplicate: 0, rejected: 0, xmlPending: 0, matches: 0, mismatches: 0 });
  });
  it('disabled settings dominate live/local gates', () => {
    for (const mode of ['LIVE_READ_ONLY', 'LOCAL_FIXTURE'] as const)
      expect(receptionReadiness({ ...settings(), enabled: false, mode }, ruc, syntheticSecrets)).toBe('DISABLED');
  });
  it('requires explicit local fixture gate and fictional recipient', () => {
    const local = { ...settings(), mode: 'LOCAL_FIXTURE' as const };
    expect(receptionReadiness(local, ruc, {})).toBe('WAITING_TI');
    vi.stubEnv('RECEIVED_LOCAL_FIXTURE_ENABLED', '1'); expect(receptionReadiness(local, ruc, {})).toBe('WAITING_TI');
    vi.stubEnv('RECEIVED_LOCAL_FIXTURE_ENABLED', 'true'); expect(receptionReadiness(local, ruc, {})).toBe('READY_LOCAL');
    expect(receptionReadiness(local, '99999999999', syntheticSecrets)).toBe('WAITING_TI');
    expect(parseAutomationSave({ ...saveInput(), settings: local }, ruc).settings.mode).toBe('LOCAL_FIXTURE');
    accessFailure(() => parseAutomationSave({ ...saveInput(), settings: local }, '99999999999'), 400);
  });
  it.each(['false', '', '1', 'TRUE'])('requires exact true live gate, not %j', value => {
    vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED', value); expect(receptionReadiness(settings(), ruc, syntheticSecrets)).toBe('WAITING_TI');
  });
  it('requires approved IMAP and every secret of enabled connectors; disabled connectors require none', () => {
    vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED', 'true');
    expect(receptionReadiness(settings(), ruc, syntheticSecrets)).toBe('READY_READ_ONLY');
    for (const missing of Object.keys(syntheticSecrets)) {
      const secrets: Record<string, string> = { ...syntheticSecrets }; delete secrets[missing];
      expect(receptionReadiness(settings(), ruc, secrets)).toBe('WAITING_TI');
    }
    vi.stubEnv('RECEIVED_IMAP_APPROVED_HOSTS', 'other.qa.example.com');
    expect(receptionReadiness(settings(), ruc, syntheticSecrets)).toBe('WAITING_TI');
    const sireOnly = settings(); sireOnly.mailbox.enabled = false;
    expect(receptionReadiness(sireOnly, ruc, { sireClientSecret: 'FAKE', solPassword: 'FAKE' })).toBe('READY_READ_ONLY');
    const mailOnly = settings(); mailOnly.sire.enabled = false;
    vi.stubEnv('RECEIVED_IMAP_APPROVED_HOSTS', host);
    expect(receptionReadiness(mailOnly, ruc, { mailPassword: fakePassword })).toBe('READY_READ_ONLY');
  });
  it.each([null, [], 'settings', 42, {}, { settings: [] }])('rejects non-object or absent settings %j', input => accessFailure(() => parseAutomationSave(input, ruc), 400));
  it.each(['root', 'settings', 'mailbox', 'sire', 'credentials'])('rejects unknown keys at %s', level => {
    const input = saveInput();
    const target = level === 'root' ? input : level === 'settings' ? input.settings : level === 'credentials' ? input.credentials : input.settings[level as 'mailbox' | 'sire'];
    Object.assign(target, { writeSunat: true }); accessFailure(() => parseAutomationSave(input, ruc), 400, 'Campo de recepción no permitido');
  });
  it.each([-1, 2147483647, 1.5, '1', null, NaN])('rejects revision %j', value => accessFailure(() => parseAutomationSave({ ...saveInput(), expectedRevision: value }, ruc), 400));
  it.each([0, 2147483646])('accepts revision boundary %i', value => expect(parseAutomationSave({ ...saveInput(), expectedRevision: value }, ruc).expectedRevision).toBe(value));
  it.each([4, 1441, 5.5, '15', null])('rejects interval %j', value => accessFailure(() => parseAutomationSave({ ...saveInput(), settings: { ...settings(), intervalMinutes: value } }, ruc), 400));
  it.each([5, 1440])('accepts interval boundary %i', value => expect(parseAutomationSave({ ...saveInput(), settings: { ...settings(), intervalMinutes: value } }, ruc).settings.intervalMinutes).toBe(value));
  it.each([
    { mode: 'LIVE_WRITE' }, { enabled: 'true' }, { mailbox: null }, { sire: [] },
    { mailbox: { ...settings().mailbox, enabled: 'true' } }, { mailbox: { ...settings().mailbox, port: 143 } },
    { mailbox: { ...settings().mailbox, folder: '' } }, { mailbox: { ...settings().mailbox, folder: 'X'.repeat(151) } },
    { mailbox: { ...settings().mailbox, username: 'X'.repeat(255) } }, { mailbox: { ...settings().mailbox, host: 'bad\r\nHost' } },
    { sire: { ...settings().sire, enabled: 'true' } }, { sire: { ...settings().sire, startPeriod: '202613' } },
  ])('rejects invalid settings %j', patch => accessFailure(() => parseAutomationSave({ ...saveInput(), settings: { ...settings(), ...patch } }, ruc), 400));
  it('requires connector details and at least one enabled connector for automation', () => {
    for (const patch of [
      { mailbox: { ...settings().mailbox, username: '' } }, { mailbox: { ...settings().mailbox, host: '127.0.0.1' } },
      { sire: { ...settings().sire, clientId: '' } }, { sire: { ...settings().sire, solUsername: '' } },
      { mailbox: { ...settings().mailbox, enabled: false }, sire: { ...settings().sire, enabled: false } },
    ]) accessFailure(() => parseAutomationSave({ ...saveInput(), settings: { ...settings(), ...patch } }, ruc), 400);
    const disabled = defaultReceptionSettings();
    expect(parseAutomationSave({ expectedRevision: 0, settings: disabled }, ruc).credentials).toEqual({});
  });
  it('empty secret entries preserve stored secrets and only explicit replacement values survive', () => {
    expect(parseAutomationSave({ ...saveInput(), credentials: { mailPassword: '', solPassword: 'FAKE-new' } }, ruc).credentials).toEqual({ solPassword: 'FAKE-new' });
    expect(parseAutomationSave({ ...saveInput(), credentials: undefined }, ruc).credentials).toEqual({});
    expect(parseAutomationSave({ ...saveInput(), credentials: { mailPassword: 'X'.repeat(1024) } }, ruc).credentials?.mailPassword).toHaveLength(1024);
    for (const credentials of [null, [], { mailPassword: 123 }, { mailPassword: 'bad\nsecret' }, { mailPassword: 'X'.repeat(1025) }])
      accessFailure(() => parseAutomationSave({ ...saveInput(), credentials }, ruc), 400);
  });
  it.each(['fixture-client', 'A'.repeat(128)])('accepts alphanumeric/hyphen client ID boundary', clientId => {
    const input = saveInput(); input.settings.sire.clientId = clientId; expect(parseAutomationSave(input, ruc).settings.sire.clientId).toBe(clientId);
  });
  it.each(['A'.repeat(129), '../client', 'client_id', 'client id', 'https://qa.invalid', 'client\nsecret'])('rejects invalid client ID %j', clientId => {
    const input = saveInput(); input.settings.sire.clientId = clientId; accessFailure(() => parseAutomationSave(input, ruc), 400);
  });
  it('accepts 32 alphanumeric SOL characters and rejects prefixed/long/non-alphanumeric SOL aliases', () => {
    const input = saveInput(); input.settings.sire.solUsername = 'A'.repeat(32); expect(parseAutomationSave(input, ruc).settings.sire.solUsername).toHaveLength(32);
    for (const solUsername of ['A'.repeat(33), ruc + 'FAKEUSER', otherRuc + 'FAKEUSER', 'FAKE-USER', 'FAKE USER', 'FAKE_USER'])
      accessFailure(() => parseAutomationSave({ ...saveInput(), settings: { ...settings(), sire: { ...settings().sire, solUsername } } }, ruc), 400);
  });
});

describe('IMAP host allowlist', () => {
  it.each([host, 'imap-1.qa.example.com', 'a.co'])('accepts DNS syntax %s', value => expect(imapHost(value)).toBe(true));
  it.each([
    '', 'localhost', '127.0.0.1', '10.0.0.1', '::1', '[::1]', 'https://imap.qa.example.com', 'user@imap.qa.example.com',
    'imap.qa.example.com:993', 'IMAP.qa.example.com', 'imap.qa.example.com.', '-imap.example.com', 'imap_.example.com',
    'imap.local', 'imap.internal', 'imap.invalid', 'imap.test', 'imap.onion', 'imap.lan', 'imap.home',
    'imap.qa.example.com\n', `${'a'.repeat(64)}.example.com`, `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
  ])('rejects non-public/invalid hostname syntax %j', value => expect(imapHost(value)).toBe(false));
  it('requires exact membership, validates entire list, normalizes list and caps at sixteen hosts', () => {
    expect(imapApproved(host, ` ${host.toUpperCase()} , other.qa.example.com `)).toBe(true);
    for (const value of ['', 'qa.example.com', '*.qa.example.com', `${host},localhost`, `${host},`, `${host},127.0.0.1`]) expect(imapApproved(host, value)).toBe(false);
    expect(imapApproved('evil.' + host, host)).toBe(false);
    const hosts = Array.from({ length: 16 }, (_, i) => `imap${i}.qa.example.com`);
    expect(imapApproved(hosts[0], hosts.join(','))).toBe(true);
    expect(imapApproved(hosts[0], [...hosts, host].join(','))).toBe(false);
  });
});

describe('fiscal decimal comparison without floating-point rounding', () => {
  it.each([
    ['118', '118.00'], ['118.0', '118.000000'], ['000118.00', '118'], ['0', '-0.000000'],
    ['-118', '-118.00'], ['9999999999999999.99', '9999999999999999.990000'], ['0.10', '0.100000'],
  ])('matches exact cents %s and %s', (a, b) => expect(fiscalAmountsMatch(a, b)).toBe(true));
  it.each([
    [null, null], [null, '0'], ['0', null], ['118.00', '118.01'], ['-118.00', '118.00'],
    ['9999999999999999.98', '9999999999999999.99'], ['0.10', '0.100001'], ['1.005', '1.01'],
  ])('does not infer or round %j and %j', (a, b) => expect(fiscalAmountsMatch(a, b)).toBe(false));
  it.each(['', ' 118', '118 ', '+118', '1e2', '1,000.00', '118,00', 'NaN', 'Infinity', '.10', '1.', '1.0000000', '10000000000000000', '1.001'])
    ('rejects invalid fiscal value %j even compared with itself', value => expect(fiscalAmountsMatch(value, value)).toBe(false));
});

describe('reception periods use America/Lima irrespective of machine timezone', () => {
  it.each([
    ['2026-01-01T04:59:59.999Z', '202512', ['202510', '202511', '202512']],
    ['2026-01-01T05:00:00.000Z', '202601', ['202511', '202512', '202601']],
    ['2026-04-01T04:59:59.999Z', '202603', ['202601', '202602', '202603']],
    ['2026-04-01T05:00:00.000Z', '202604', ['202602', '202603', '202604']],
  ] as const)('honors Lima month boundary %s', (iso, current, expected) => {
    vi.stubEnv('TZ', 'Pacific/Auckland'); const now = new Date(iso);
    expect(defaultReceptionSettings(now).sire.startPeriod).toBe(current);
    expect(receptionPeriods('202401', now)).toEqual(expected);
  });
  it('caps at three months, clips to startPeriod and never schedules future periods', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    expect(receptionPeriods('202401', now)).toEqual(['202608', '202609', period]);
    expect(receptionPeriods('202609', now)).toEqual(['202609', period]);
    expect(receptionPeriods(period, now)).toEqual([period]); expect(receptionPeriods('202611', now)).toEqual([]);
  });
  it('save validation uses current Lima period, including the first five UTC hours', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-04-01T04:59:59Z'));
    const input = saveInput(); input.settings.sire.startPeriod = '202603'; expect(parseAutomationSave(input, ruc).settings.sire.startPeriod).toBe('202603');
    input.settings.sire.startPeriod = '202604'; accessFailure(() => parseAutomationSave(input, ruc), 400);
  });
  it.each(['202600', '202613', '2026-10', '199912', '../202610', '', 202610])('rejects invalid period %j', value => {
    expect(validPeriod(value)).toBe(false); accessFailure(() => receptionPeriods(value as string), 400);
  });
});

describe('ReceptionVault AES-GCM with mocked synthetic key file', () => {
  const context: ReceptionSecretContext = { companyId: 101, ruc, revision: 2 };
  it('round-trips domain-separated credentials, uses fresh 12-byte IVs, wipes read buffers and closes every fd', () => {
    const vault = new ReceptionVault(), first = vault.seal(syntheticSecrets, context), second = vault.seal(syntheticSecrets, context);
    expect(first).not.toBe(second); expect(first.split('.')).toHaveLength(4);
    const parts = first.split('.'); expect(parts[0]).toBe('v1'); expect(Buffer.from(parts[1], 'base64url')).toHaveLength(12); expect(Buffer.from(parts[2], 'base64url')).toHaveLength(16);
    expect(vault.open(first, context)).toEqual(syntheticSecrets);
    for (const secret of Object.values(syntheticSecrets)) expect(first).not.toContain(secret);
    expect(guards.openSync).toHaveBeenCalledTimes(3); expect(guards.closeSync).toHaveBeenCalledTimes(3);
    for (const call of guards.readSync.mock.calls) expect((call[1] as Buffer).every(byte => byte === 0)).toBe(true);
  });
  it.each(['hex', 'base64', 'base64url'])('supports a synthetic 32-byte master encoded as %s', encoding => {
    keyText = Buffer.alloc(32, 0x11).toString(encoding as BufferEncoding);
    const vault = new ReceptionVault(); expect(vault.open(vault.seal(syntheticSecrets, context), context)).toEqual(syntheticSecrets);
  });
  it('opens absent credentials without accessing a key file', () => {
    vi.stubEnv('RECEIVED_SETTINGS_KEY_FILE', ''); expect(new ReceptionVault().open(null, context)).toEqual({}); expect(guards.openSync).not.toHaveBeenCalled();
  });
  it.each([{ companyId: 202 }, { ruc: otherRuc }, { revision: 3 }])('rejects changed AAD context %j with sanitized error', patch => {
    const vault = new ReceptionVault(), envelope = vault.seal(syntheticSecrets, context);
    accessFailure(() => vault.open(envelope, { ...context, ...patch }), 503, 'Integridad de credenciales de recepción no verificable');
  });
  it.each([1, 2, 3])('rejects altered IV/tag/ciphertext section %i', index => {
    const vault = new ReceptionVault(), parts = vault.seal(syntheticSecrets, context).split('.');
    const bytes = Buffer.from(parts[index], 'base64url'); bytes[0] ^= 1; parts[index] = bytes.toString('base64url');
    accessFailure(() => vault.open(parts.join('.'), context), 503, 'Integridad de credenciales de recepción no verificable');
  });
  it('rejects a different master key and malformed/noncanonical/oversized envelopes', () => {
    const vault = new ReceptionVault(), envelope = vault.seal(syntheticSecrets, context);
    keyText = Buffer.alloc(32, 0x22).toString('hex'); accessFailure(() => vault.open(envelope, context), 503);
    for (const value of ['v2.a.b.c', 'v1.a.b', 'v1.a.b.c.d', envelope + '=', 'X'.repeat(11501), 'v1.AA.AA.AA']) accessFailure(() => vault.open(value, context), 503);
  });
  it('rejects invalid key configuration/file data and always closes opened descriptors', () => {
    const vault = new ReceptionVault();
    for (const path of ['', 'relative/key']) { vi.stubEnv('RECEIVED_SETTINGS_KEY_FILE', path); accessFailure(() => vault.seal(syntheticSecrets, context), 503); }
    vi.stubEnv('RECEIVED_SETTINGS_KEY_FILE', fakeKeyPath);
    for (const value of ['X'.repeat(64), 'a'.repeat(42), 'a'.repeat(129), Buffer.alloc(31).toString('hex')]) {
      keyText = value; accessFailure(() => vault.seal(syntheticSecrets, context), 503);
    }
    keyText = Buffer.alloc(32, 0x11).toString('hex');
    guards.fstatSync.mockReturnValueOnce({ isFile: () => false, size: 64, mode: 0o100600 }); accessFailure(() => vault.seal(syntheticSecrets, context), 503);
    expect(guards.closeSync.mock.calls.length).toBe(guards.openSync.mock.calls.length);
  });
  it('sanitizes file-read failures and authenticated but invalid decrypted payloads', () => {
    const vault = new ReceptionVault();
    guards.readSync.mockImplementationOnce(() => { throw new Error('FAKE-KEY-ERROR-CONTENT'); });
    accessFailure(() => vault.seal(syntheticSecrets, context), 503, 'Secreto de cifrado de recepción no disponible o inválido');
    const invalidPayloads: Record<string, string>[] = [{ unknown: 'FAKE' }, { mailPassword: 'X'.repeat(1025) }];
    for (const value of invalidPayloads) {
      const envelope = vault.seal(value, context); accessFailure(() => vault.open(envelope, context), 503);
    }
  });
  it.each([{ companyId: 0 }, { companyId: 1.5 }, { ruc: 'bad' }, { revision: 0 }])('rejects invalid sealing context %j', patch => {
    accessFailure(() => new ReceptionVault().seal(syntheticSecrets, { ...context, ...patch }), 400);
  });
});

describe('synthetic MIME XML and importer projection', () => {
  it('decodes deterministic fixture with an identical fiscal key for its selected period', async () => {
    const raw = fixtureMail(ruc, period); expect(fixtureMail(ruc, period)).toEqual(raw);
    const attachments = await mailAttachments(raw); expect(attachments).toHaveLength(1);
    expect(attachments[0].fileName).toBe(`00000000002-01-FZ01-${period}.xml`);
    const prepared = prepareMailDocuments(attachments, ruc); expect(prepared.rejected).toBe(0); expect(prepared.artifacts).toEqual([]);
    expect(prepared.documents[0].projection).toMatchObject({ fullNumber: `FZ01-${period}`, issueDate: '2026-10-01', currencyCode: 'PEN',
      supplier: { identityNumber: '00000000002', identityType: '6' }, recipient: { identityNumber: ruc, identityType: '6' }, totals: { payableAmount: '118.00' } });
    expect(prepared.documents[0].projection.items).toHaveLength(1);
    expect(prepared.documents[0].projection.xmlSha256).toBe(createHash('sha256').update(attachments[0].bytes).digest('hex'));
    expect(prepared.documents[0].projection).not.toHaveProperty('sunatStatus');
  });
  it.each([['99999999999', period], [ruc, '202613'], ['00', period]])('refuses non-fictional/malformed fixture scope %s %s', (identity, value) => expect(() => fixtureMail(identity, value)).toThrow('FIXTURE_SCOPE_REQUIRED'));
  it('uses XML recipient authority regardless of MIME To or remote links and filters unrelated attachments', async () => {
    const xml = await mailXml(); const attachments = await mailAttachments(mime([xml, { fileName: 'ignore.txt', bytes: Buffer.from('not an invoice') }]));
    expect(attachments).toEqual([xml]); expect(prepareMailDocuments(attachments, ruc).documents).toHaveLength(1); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'missing', 'dni', 'contradictory'])('rejects %s XML recipient without inventing ownership', async kind => {
    const original = await mailXml(); let xml = original.bytes.toString();
    const identity = `<cbc:ID schemeID="6">${ruc}</cbc:ID>`;
    if (kind === 'foreign') xml = xml.replace(identity, `<cbc:ID schemeID="6">${otherRuc}</cbc:ID>`);
    if (kind === 'missing') xml = xml.replace(identity, '');
    if (kind === 'dni') xml = xml.replace(identity, '<cbc:ID schemeID="1">12345678</cbc:ID>');
    if (kind === 'contradictory') xml = xml.replace('<cac:AccountingCustomerParty>', `<cac:AccountingCustomerParty><cbc:CustomerAssignedAccountID>${otherRuc}</cbc:CustomerAssignedAccountID>`);
    const attachments = await mailAttachments(mime([{ ...original, bytes: Buffer.from(xml) }]));
    expect(prepareMailDocuments(attachments, ruc)).toMatchObject({ documents: [], rejected: 1 });
  });
  it('keeps valid XML while reporting rejected documents in the same mail', async () => {
    const good = await mailXml(), bad = { fileName: 'foreign.xml', bytes: Buffer.from(good.bytes.toString().replace(`<cbc:ID schemeID="6">${ruc}</cbc:ID>`, `<cbc:ID schemeID="6">${otherRuc}</cbc:ID>`)) };
    const prepared = prepareMailDocuments(await mailAttachments(mime([good, bad])), ruc);
    expect(prepared.documents).toHaveLength(1); expect(prepared.rejected).toBe(1);
  });
  it('rejects invalid MIME/attachment bounds and never processes PDF-only mail as a complete invoice', async () => {
    await expect(mailAttachments(Buffer.alloc(0))).rejects.toMatchObject({ status: 400, message: 'MAIL_TOO_LARGE' });
    await expect(mailAttachments(Buffer.alloc(MAX_MAIL_BYTES + 1))).rejects.toMatchObject({ status: 400, message: 'MAIL_TOO_LARGE' });
    await expect(mailAttachments(mime(Array.from({ length: 11 }, (_, i) => ({ fileName: `invoice${i}.xml`, bytes: Buffer.from('x') }))))).rejects.toMatchObject({ message: 'MAIL_ATTACHMENT_LIMIT' });
    await expect(mailAttachments(mime([{ fileName: 'huge.xml', bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 65) }]))).rejects.toMatchObject({ message: 'MAIL_ATTACHMENT_LIMIT' });
    const pdf = await mailAttachments(mime([{ fileName: 'invoice.pdf', bytes: Buffer.from('%PDF-FAKE') }]));
    expect(() => prepareMailDocuments(pdf, ruc)).toThrow();
  });
  it('refuses dangerous attachment names and invalid provider PDF bytes', async () => {
    await expect(mailAttachments(mime([{ fileName: 'unsafe..xml', bytes: Buffer.from('x') }]))).rejects.toBeInstanceOf(AccessError);
    const xml = await mailXml(); expect(() => prepareMailDocuments([xml, { fileName: 'invoice.pdf', bytes: Buffer.from('not pdf') }], ruc)).toThrow('MAIL_PDF_INVALID');
  });
});

describe('fake IMAP read-only cursors, gaps and bounded downloads', () => {
  it('requires authorization before constructing even an injected client and checks TLS/logging/bounds', async () => {
    const fake = fakeImap();
    await expect(visitMailbox(settings().mailbox, fakePassword, null, fake.consume, false, fake.factory)).rejects.toMatchObject({ status: 403, message: 'MAIL_READ_NOT_AUTHORIZED' });
    expect(fake.factory).not.toHaveBeenCalled();
    expect(mailboxOptions(settings().mailbox, fakePassword, true)).toMatchObject({ host, port: 993, secure: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: host }, logger: false, emitLogs: false, logRaw: false,
      disableAutoIdle: true, disableCompression: true, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
      maxLineLength: 65536, maxLiteralSize: MAX_MAIL_BYTES, maxResponseSize: MAX_MAIL_BYTES + 65536 });
    for (const m of [{ ...settings().mailbox, host: 'unapproved.qa.example.com' }, { ...settings().mailbox, port: 143 }, { ...settings().mailbox, username: '' }])
      accessFailure(() => mailboxOptions(m as ReceivedAutomationSettings['mailbox'], fakePassword, true), 403);
    accessFailure(() => mailboxOptions(settings().mailbox, '', true), 403);
  });
  it('opens readOnly, downloads by UID/PEEK with maxBytes, zeroes consumed bytes, releases lock and never writes flags', async () => {
    const fake = fakeImap(), observed: string[] = [];
    const consume = vi.fn(async (message: MailMessage) => { observed.push(message.raw!.toString()); });
    expect(await fake.visit(null, consume)).toEqual({ uidValidity: '91', lastUid: 1 });
    expect(observed).toEqual(['ABC']); expect(fake.client.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(fake.client.fetchAll).toHaveBeenCalledWith('1:1', { uid: true, size: true }, { uid: true });
    expect(fake.client.download).toHaveBeenCalledWith('1', undefined, { uid: true, maxBytes: MAX_MAIL_BYTES });
    expect(consume.mock.calls[0][0].raw).toEqual(Buffer.alloc(3)); expect(fake.release).toHaveBeenCalledTimes(1); expect(fake.close).toHaveBeenCalledTimes(1);
    for (const method of [fake.client.messageFlagsAdd, fake.client.messageFlagsSet, fake.client.messageDelete, fake.client.messageMove, fake.client.append, fake.client.expunge]) expect(method).not.toHaveBeenCalled();
  });
  it('retains UIDVALIDITY checkpoint and scans only unseen UIDs, sorting and filtering metadata', async () => {
    const fake = fakeImap({ uidNext: 8, meta: [{ uid: 7, size: 3 }, { uid: 2, size: 3 }, { uid: 99, size: 3 }, { uid: 4, size: 3 }] });
    expect(await fake.visit({ uidValidity: '91', lastUid: 3n })).toEqual({ uidValidity: '91', lastUid: 7 });
    expect(fake.client.fetchAll).toHaveBeenCalledWith('4:7', { uid: true, size: true }, { uid: true });
    expect(fake.consume.mock.calls.map(([message]) => message.uid)).toEqual([4, 7]);
  });
  it('resets checkpoint on UIDVALIDITY change instead of skipping the rebuilt mailbox', async () => {
    const fake = fakeImap({ uidValidity: 92n }); expect(await fake.visit({ uidValidity: '91', lastUid: 999n })).toEqual({ uidValidity: '92', lastUid: 1 });
    expect(fake.client.fetchAll).toHaveBeenCalledWith('1:1', { uid: true, size: true }, { uid: true });
  });
  it('does not fetch/download an empty or already consumed mailbox', async () => {
    for (const [uidNext, checkpoint] of [[1, null], [2, { uidValidity: '91', lastUid: 1n }]] as const) {
      const fake = fakeImap({ uidNext }); await fake.visit(checkpoint);
      expect(fake.client.fetchAll).not.toHaveBeenCalled(); expect(fake.client.download).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalledTimes(1);
    }
  });
  it('advances over deleted UID gaps but scans at most 1000 UIDs per visit', async () => {
    const fake = fakeImap({ uidNext: 2501, meta: [] });
    expect(await fake.visit({ uidValidity: '91', lastUid: 100n })).toEqual({ uidValidity: '91', lastUid: 1100 });
    expect(fake.client.fetchAll).toHaveBeenCalledWith('101:1100', { uid: true, size: true }, { uid: true }); expect(fake.client.download).not.toHaveBeenCalled();
  });
  it('consumes at most 50 messages and resumes remaining metadata instead of advancing past unprocessed UIDs', async () => {
    const fake = fakeImap({ uidNext: 61, meta: Array.from({ length: 60 }, (_, i) => ({ uid: i + 1, size: 3 })) });
    expect(await fake.visit()).toEqual({ uidValidity: '91', lastUid: 50 }); expect(fake.consume).toHaveBeenCalledTimes(50); expect(fake.client.download).toHaveBeenCalledTimes(50);
  });
  it.each([undefined, 0, -1, 1.5, MAX_MAIL_BYTES + 1])('reports metadata size %j without downloading and advances rejection checkpoint', async size => {
    const fake = fakeImap({ meta: [{ uid: 1, size }] }); expect(await fake.visit()).toEqual({ uidValidity: '91', lastUid: 1 });
    expect(fake.consume).toHaveBeenCalledWith({ uid: 1, uidValidity: '91', raw: null, errorCode: 'MAIL_TOO_LARGE' }); expect(fake.client.download).not.toHaveBeenCalled();
  });
  it('enforces actual streaming bounds, destroys oversized stream and refuses incomplete downloads', async () => {
    const oversized = fakeImap({ meta: [{ uid: 1, size: MAX_MAIL_BYTES }] });
    const stream = Readable.from([Buffer.alloc(MAX_MAIL_BYTES), Buffer.from('x')]), destroy = vi.spyOn(stream, 'destroy');
    oversized.client.download.mockResolvedValueOnce({ content: stream });
    await expect(oversized.visit()).rejects.toMatchObject({ status: 503, message: 'MAIL_DOWNLOAD_LIMIT' }); expect(destroy).toHaveBeenCalled();
    expect(oversized.consume).not.toHaveBeenCalled(); expect(oversized.release).toHaveBeenCalledTimes(1); expect(oversized.close).toHaveBeenCalledTimes(1);
    const incomplete = fakeImap({ meta: [{ uid: 1, size: 4 }] });
    await expect(incomplete.visit()).rejects.toMatchObject({ message: 'MAIL_DOWNLOAD_INCOMPLETE' }); expect(incomplete.consume).not.toHaveBeenCalled();
  });
  it('accepts exactly sixteen MiB, assembles chunks, then wipes the callback raw buffer', async () => {
    const fake = fakeImap({ meta: [{ uid: 1, size: MAX_MAIL_BYTES }] });
    fake.client.download.mockResolvedValueOnce({ content: Readable.from([Buffer.alloc(MAX_MAIL_BYTES / 2, 65), Buffer.alloc(MAX_MAIL_BYTES / 2, 66)]) });
    const consume = vi.fn(async (message: MailMessage) => { expect(message.raw).toHaveLength(MAX_MAIL_BYTES); expect(message.raw![0]).toBe(65); expect(message.raw!.at(-1)).toBe(66); });
    await fake.visit(null, consume); expect(consume.mock.calls[0][0].raw?.every(byte => byte === 0)).toBe(true);
  });
  it('does not advance when consumer fails; wipes downloaded bytes and cleans up the lock/client', async () => {
    const fake = fakeImap(); fake.consume.mockImplementationOnce(async () => { throw new Error(fakePassword + ' https://secret.invalid'); });
    await expect(fake.visit()).rejects.toMatchObject({ status: 503, message: 'MAIL_CONNECTION_FAILED' });
    expect(fake.consume.mock.calls[0][0].raw).toEqual(Buffer.alloc(3)); expect(fake.release).toHaveBeenCalledTimes(1); expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    { uidValidity: 'invalid' }, { uidValidity: '1'.repeat(21) }, { uidNext: 0 }, { uidNext: 1.5 }, { uidNext: 4294967297 },
  ])('rejects malformed server cursor %j before fetching', async options => {
    const fake = fakeImap(options); await expect(fake.visit()).rejects.toMatchObject({ message: 'MAILBOX_CURSOR_INVALID' });
    expect(fake.client.fetchAll).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalledTimes(1); expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it.each([-1n, 4294967296n, 9007199254740993n])('rejects invalid matching checkpoint UID %s', async lastUid => {
    const fake = fakeImap(); await expect(fake.visit({ uidValidity: '91', lastUid })).rejects.toMatchObject({ message: 'MAILBOX_CURSOR_INVALID' }); expect(fake.client.fetchAll).not.toHaveBeenCalled();
  });
  it('rejects oversized metadata batches, unavailable mailbox/message and sanitizes connect failures', async () => {
    const large = fakeImap({ uidNext: 1001, meta: Array.from({ length: 1001 }, () => ({ uid: 1, size: 3 })) });
    await expect(large.visit()).rejects.toMatchObject({ message: 'MAILBOX_BATCH_INVALID' }); expect(large.client.download).not.toHaveBeenCalled();
    const missing = fakeImap({ mailbox: false }); await expect(missing.visit()).rejects.toMatchObject({ message: 'MAILBOX_UNAVAILABLE' });
    const gone = fakeImap(); gone.client.download.mockResolvedValueOnce(undefined); await expect(gone.visit()).rejects.toMatchObject({ message: 'MAIL_MESSAGE_UNAVAILABLE' });
    const failed = fakeImap(); failed.client.connect.mockRejectedValueOnce(new Error(fakePassword + ' ' + host));
    await expect(failed.visit()).rejects.toMatchObject({ status: 503, message: 'MAIL_CONNECTION_FAILED' }); expect(failed.client.getMailboxLock).not.toHaveBeenCalled(); expect(failed.close).toHaveBeenCalledTimes(1);
  });
  it('closes the injected client after the ninety-second visit deadline', async () => {
    vi.useFakeTimers(); const fake = fakeImap(); let reject!: (error: Error) => void;
    fake.client.connect.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    const pending = fake.visit(); const assertion = expect(pending).rejects.toMatchObject({ message: 'MAIL_CONNECTION_FAILED' });
    await vi.advanceTimersByTimeAsync(89999); expect(fake.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(fake.close).toHaveBeenCalledTimes(1); reject(new Error('FAKE disconnect')); await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fingerprint excludes password while changing for each mailbox identity setting', () => {
    const base = settings().mailbox, fingerprint = mailboxFingerprint(base); expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(mailboxFingerprint({ ...base })).toBe(fingerprint);
    for (const patch of [{ host: 'other.qa.example.com' }, { folder: 'Receipts' }, { username: 'OTHER-FAKE' }]) expect(mailboxFingerprint({ ...base, ...patch })).not.toBe(fingerprint);
  });
});

describe('importPreparedMail using only transaction mocks', () => {
  const documentId = '00000000-0000-4000-8000-000000000101';
  const binding = { companyId: 101, recipientRuc: ruc, configuredBy: '00000000-0000-4000-8000-000000000901' };
  type Existing = { id: string; companyId: number; xmlSha256: string };
  function transaction(existing: Existing | null = null) {
    const mock = {
      receivedDocument: { findUnique: vi.fn(async (_input: unknown) => existing), create: vi.fn(async (_input: unknown) => ({ id: documentId })) },
      receivedAudit: { create: vi.fn(async (_input: unknown) => ({})) },
      receivedArtifact: { findUnique: vi.fn(async (_input: unknown): Promise<{ id: string } | null> => null), count: vi.fn(async (_input: unknown) => 0), create: vi.fn(async (_input: unknown) => ({})) },
      $queryRaw: vi.fn(async () => []),
    };
    return { mock, tx: mock as unknown as Parameters<typeof importPreparedMail>[0] };
  }
  const prepared = async () => prepareMailDocuments(await mailAttachments(fixtureMail(ruc, period)), ruc);
  it('imports original XML/items/hash under the authorized recipient with pending branch and an automatic audit', async () => {
    const mail = await prepared(), { tx, mock } = transaction();
    expect(await importPreparedMail(tx, binding, mail, 'FAKE-run')).toEqual({ counts: { imported: 1, duplicate: 0, rejected: 0 }, changed: [documentId] });
    expect(mock.receivedDocument.findUnique).toHaveBeenCalledWith({ where: { recipientRuc_supplierRuc_documentType_series_number: { recipientRuc: ruc, supplierRuc: '00000000002', documentType: '01', series: 'FZ01', number: period } } });
    const input = mock.receivedDocument.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(input.data).toMatchObject({ companyId: 101, recipientRuc: ruc, branchId: null, fullNumber: `FZ01-${period}`,
      issueDate: new Date('2026-10-01T00:00:00Z'), currencyCode: 'PEN', payableAmount: '118.00', xmlSha256: mail.documents[0].projection.xmlSha256,
      artifacts: { create: { kind: 'XML', bytes: new Uint8Array(mail.documents[0].file.bytes) } },
      audits: { create: { actorId: binding.configuredBy, action: 'AUTOMATIC_IMPORTED', detail: { source: 'MAIL_WORKER', branchAssignment: 'PENDING' } } },
    });
    expect(input.data).not.toHaveProperty('sunatStatus'); expect(input.data).not.toHaveProperty('cdrStatus');
    expect(input.data).not.toHaveProperty('outbox'); expect(mock.receivedDocument.create).toHaveBeenCalledTimes(1);
  });
  it('deduplicates identical XML within the same company without creating another document/audit', async () => {
    const mail = await prepared(), { tx, mock } = transaction({ id: documentId, companyId: 101, xmlSha256: mail.documents[0].projection.xmlSha256 });
    expect(await importPreparedMail(tx, binding, mail, 'FAKE-run')).toEqual({ counts: { imported: 0, duplicate: 1, rejected: 0 }, changed: [] });
    expect(mock.receivedDocument.create).not.toHaveBeenCalled(); expect(mock.receivedAudit.create).not.toHaveBeenCalled();
  });
  it.each([101, 202])('rejects conflicting stored ownership/hash for company %i with scoped audit', async companyId => {
    const mail = await prepared(), { tx, mock } = transaction({ id: documentId, companyId, xmlSha256: 'FAKE-different-hash' });
    expect(await importPreparedMail(tx, binding, mail, 'FAKE-run')).toEqual({ counts: { imported: 0, duplicate: 0, rejected: 1 }, changed: [] });
    expect(mock.receivedDocument.create).not.toHaveBeenCalled(); expect(mock.receivedAudit.create).toHaveBeenCalledTimes(companyId === 101 ? 1 : 0);
    if (companyId === 101) expect(mock.receivedAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ documentId, action: 'AUTOMATIC_CONFLICT' }) });
  });
  it('rejects binding recipient mismatch before any persistence call', async () => {
    const mail = await prepared(), { tx, mock } = transaction();
    await expect(importPreparedMail(tx, { ...binding, recipientRuc: otherRuc }, mail, 'FAKE-run')).rejects.toThrow('MAIL_RECIPIENT_MISMATCH');
    expect(mock.receivedDocument.findUnique).not.toHaveBeenCalled(); expect(mock.receivedDocument.create).not.toHaveBeenCalled();
  });
  it('attaches only uniquely matching provider PDFs, locks parent and deduplicates artifact hashes', async () => {
    const xml = await mailXml(), pdf = { fileName: `00000000002-01-FZ01-${period}.pdf`, bytes: Buffer.from('%PDF-FAKE') };
    const mail = prepareMailDocuments([xml, pdf, { ...pdf, fileName: 'unmatched.pdf' }], ruc), { tx, mock } = transaction();
    const result = await importPreparedMail(tx, binding, mail, 'FAKE-run');
    expect(result).toEqual({ counts: { imported: 1, duplicate: 0, rejected: 1 }, changed: [documentId] }); expect(mock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mock.receivedArtifact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ documentId, kind: 'PROVIDER_PDF', fileName: pdf.fileName, sha256: createHash('sha256').update(pdf.bytes).digest('hex') }) });
    const duplicate = transaction(); duplicate.mock.receivedArtifact.findUnique.mockResolvedValueOnce({ id: 'FAKE-existing-artifact' });
    await importPreparedMail(duplicate.tx, binding, prepareMailDocuments([xml, pdf], ruc), 'FAKE-run'); expect(duplicate.mock.receivedArtifact.create).not.toHaveBeenCalled();
    const full = transaction(); full.mock.receivedArtifact.count.mockResolvedValueOnce(20);
    expect((await importPreparedMail(full.tx, binding, prepareMailDocuments([xml, pdf], ruc), 'FAKE-run')).counts.rejected).toBe(1); expect(full.mock.receivedArtifact.create).not.toHaveBeenCalled();
  });
});
