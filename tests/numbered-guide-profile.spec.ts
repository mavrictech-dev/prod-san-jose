import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildNumberedGuideXml, validateNumberedGuideInput, NUMBERED_GUIDE_INPUT_SCHEMA_VERSION, NUMBERED_GUIDE09_PROFILE, type NumberedGuideInput } from '../packages/sunat-core/src/numbered-guide-profile';
import { guidePreparationBody } from './helpers/guide-preparation.fixture';

function fixture(): NumberedGuideInput {
  const body = guidePreparationBody();
  return { schemaVersion: NUMBERED_GUIDE_INPUT_SCHEMA_VERSION,
    documentId: '00000000-0000-4000-8000-000000000091', operationId: '00000000-0000-4000-8000-000000000092',
    issuer: { ...body.sender }, documentType: '09', series: 'TQ91', number: '17', body, snapshotSha256: 'a'.repeat(64) };
}

describe('numbered 09 owner profile remains strict and deterministic', () => {
  it('renders the actual supplied owner number, distinct from a preview or body hash', () => {
    const input = fixture(), before = structuredClone(input), result = buildNumberedGuideXml(input);
    expect(input).toEqual(before); expect(result).toEqual(buildNumberedGuideXml(input));
    expect(result).toMatchObject({ profile: NUMBERED_GUIDE09_PROFILE, fullNumber: 'TQ91-17', snapshotSha256: 'a'.repeat(64),
      environment: 'BETA', candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
      authorizedForTransfer: false, officialRulesValidated: false });
    expect(result.xmlSha256).toBe(createHash('sha256').update(result.xml, 'utf8').digest('hex'));
    expect(result.xml).toContain('<cbc:ID>TQ91-17</cbc:ID>');
    expect(result.xml).toContain('<cbc:IssueDate>2026-10-21</cbc:IssueDate><cbc:IssueTime>10:30:00</cbc:IssueTime>');
    expect(result.xml).toContain('<ext:ExtensionContent/>');
    expect(result.xml).not.toContain('<ds:Signature'); expect(result.xml).not.toContain('TST0');
  });
  it('returns an independent copy and preserves exact decimal strings and XML escaping', () => {
    const input = fixture(); input.body.items[0].description = 'FICTICIO & <uno> "dos"';
    const checked = validateNumberedGuideInput(input); checked.body.items[0].quantity = '9';
    expect(input.body.items[0].quantity).toBe('2.000001');
    const xml = buildNumberedGuideXml(input).xml;
    expect(xml).toContain('FICTICIO &amp; &lt;uno&gt; &quot;dos&quot;'); expect(xml).toContain('>2.000001</cbc:DeliveredQuantity>');
  });
  it('converts midnight to the previous Lima date without reading the clock', () => {
    const input = fixture(); input.body.issueDate = '2026-10-22T02:00:00.000Z';
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));
      expect(buildNumberedGuideXml(input).xml).toContain('<cbc:IssueDate>2026-10-21</cbc:IssueDate><cbc:IssueTime>21:00:00</cbc:IssueTime>');
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { series: 'V001' }, { number: '0' }, { number: '01' }, { number: '100000000' },
    { schemaVersion: 'factuez.numbered-guide-input.v2' }, { snapshotSha256: 'A'.repeat(64) },
    { transmissionAuthorized: true }, { environment: 'PROD' }, { verified: true },
  ])('rejects invalid identity or client authority fields %j', override => {
    expect(() => buildNumberedGuideXml({ ...fixture(), ...override })).toThrow('INVALID_NUMBERED_GUIDE_INPUT');
  });
  it('keeps legacy 31 blocked for both old public data and relabelled private data', () => {
    const input = fixture(); input.documentType = '31'; input.series = 'VQ91';
    expect(() => buildNumberedGuideXml(input)).toThrow('NUMBERED_GUIDE31_TRANSPORT_DETAILS_UNREPRESENTABLE');
    input.body.transport = { mode: '01', carrier: { ...input.issuer, mtcRegistration: 'MTC00001' } };
    expect(() => buildNumberedGuideXml(input)).toThrow('NUMBERED_GUIDE31_TRANSPORT_DETAILS_UNREPRESENTABLE');
  });
  it.each(['reason', 'mode', 'regulated', 'reference', 'sender', 'location'] as const)('keeps unsupported 09 %s blocked', field => {
    const input = fixture();
    if (field === 'reason') input.body.reasonCode = '01';
    if (field === 'mode') input.body.transport = { mode: '01', carrier: { ...input.issuer, mtcRegistration: 'MTC' } };
    if (field === 'regulated') input.body.regulatedGoods = true;
    if (field === 'reference') input.body.references.push({ type: '09', issuerRuc: input.issuer.ruc, series: 'T001', number: '1' });
    if (field === 'sender') input.body.sender.legalName = 'OTRO';
    if (field === 'location') input.body.destination.establishmentCode = input.body.origin.establishmentCode;
    expect(() => buildNumberedGuideXml(input)).toThrow();
  });
  it('rejects accessors and proxies without invoking them', () => {
    const getter = vi.fn(); const input = fixture(); Object.defineProperty(input, 'body', { enumerable: true, get: getter });
    expect(() => buildNumberedGuideXml(input)).toThrow('INVALID_NUMBERED_GUIDE_INPUT'); expect(getter).not.toHaveBeenCalled();
    expect(() => buildNumberedGuideXml(new Proxy(fixture(), { get: getter }))).toThrow('INVALID_NUMBERED_GUIDE_INPUT');
    expect(getter).not.toHaveBeenCalled();
  });
});
