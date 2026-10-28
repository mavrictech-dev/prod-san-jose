import 'reflect-metadata';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyGuideCdrEvidence, GuideCdrEvidenceError, type GuideCdrExpected } from '../services/sunat-service/src/application/guide-cdr-evidence';
import { createGuideSidecarPki, guideSidecarCdrExpected, guideSidecarCdrXml, guideSidecarPackCdr, guideSidecarHash, zipSync } from './helpers/guide-sidecar-ephemeral-pki.fixture';

let pki: ReturnType<typeof createGuideSidecarPki>;
beforeAll(() => { pki = createGuideSidecarPki(); }, 30000);
function fixture(type: '09' | '31' = '09', code = '0') {
  const expected = guideSidecarCdrExpected(type), unsigned = guideSidecarCdrXml(expected, code), xml = pki.signCdr(unsigned);
  const zip = guideSidecarPackCdr(xml, expected), verifier = { verify: vi.fn(pki.cdrVerifier.verify) };
  return { expected, unsigned, xml, zip, verifier, run: () => verifyGuideCdrEvidence(expected, zip, verifier) };
}
describe('strict guide CDR local evidence', () => {
  it.each(['09', '31'] as const)('binds a cryptographically verified %s response but never authorizes transfer', async type => {
    const f = fixture(type), result = await f.run();
    expect(result).toMatchObject({ source: 'LOCAL_EMULATOR', responseCode: '0', status: 'ACCEPTED', signatureTrusted: true,
      cryptographicReceiptVerified: true, bindingComplete: true, requestHashesBoundByCdr: false,
      officialCdrVerified: false, transmissionAuthorized: false, authorizedForTransfer: false,
      requestXmlSha256: f.expected.requestXmlSha256, requestZipSha256: f.expected.requestZipSha256 });
    expect(result.cdrXmlSha256).toBe(guideSidecarHash(f.xml)); expect(result.cdrZipSha256).toBe(guideSidecarHash(f.zip));
    expect(f.verifier.verify).toHaveBeenCalledOnce(); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.notes)).toBe(true);
    expect(f.zip).toEqual(guideSidecarPackCdr(f.xml, f.expected));
  });
  it('preserves local default and external provenance independently of cryptographic verification', async () => {
    const f = fixture(); delete f.expected.source;
    expect((await f.run()).source).toBe('LOCAL_EMULATOR');
    f.expected.source = 'EXTERNAL_CDR';
    expect(await f.run()).toMatchObject({ source: 'EXTERNAL_CDR', officialCdrVerified: false, transmissionAuthorized: false, authorizedForTransfer: false });
  });
  it('authenticates a rejection as a receipt, not an accepted response', async () => {
    const f = fixture('09', '2335');
    expect(await f.run()).toMatchObject({ status: 'REJECTED', responseCode: '2335', signatureTrusted: true, officialCdrVerified: false });
  });
  it('retains authenticated observations', async () => {
    const f = fixture(), xml = pki.signCdr(f.unsigned.replace('<cbc:ID>FICTITIOUS', '<cbc:Note>LOCAL OBSERVATION</cbc:Note><cbc:ID>FICTITIOUS'));
    expect(await verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(xml, f.expected), f.verifier)).toMatchObject({ status: 'ACCEPTED_WITH_OBSERVATIONS', notes: ['LOCAL OBSERVATION'] });
  });
  it.each([false, undefined, 1, 'true', { signatureTrusted: true, officialCdrVerified: true, accepted: true }])('rejects non-true verifier result %j', async value => {
    const f = fixture(), verifier = { verify: vi.fn(async () => value as boolean) };
    await expect(verifyGuideCdrEvidence(f.expected, f.zip, verifier)).rejects.toThrow('GUIDE_CDR_SIGNATURE_UNTRUSTED');
  });
  it('sanitizes verifier errors without leaking diagnostics', async () => {
    const f = fixture(), verifier = { verify: vi.fn(async () => { throw new Error('SECRET-PASSWORD /customer/path'); }) };
    await expect(verifyGuideCdrEvidence(f.expected, f.zip, verifier)).rejects.toMatchObject({ message: 'GUIDE_CDR_SIGNATURE_UNTRUSTED' });
  });
  it('never accepts an unsigned parser response, even with a fake accepting port', async () => {
    const f = fixture(), verifier = { verify: vi.fn(async () => true) };
    await expect(verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(f.unsigned), verifier)).rejects.toThrow('GUIDE_CDR_SIGNATURE_UNTRUSTED');
    expect(verifier.verify).not.toHaveBeenCalled();
  });
  it('cryptographic verification detects changed code even with recomputed archive CRC', async () => {
    const f = fixture(), changed = f.xml.replace('<cbc:ResponseCode>0</cbc:ResponseCode>', '<cbc:ResponseCode>2335</cbc:ResponseCode>');
    await expect(verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(changed), f.verifier)).rejects.toThrow('GUIDE_CDR_SIGNATURE_UNTRUSTED');
  });
  it('rejects XML signed with an unpinned issuer', async () => {
    const f = fixture(), g = fixture();
    // Replace KeyInfo alone: the external public pin must still determine authority.
    const embedded = pki.otherIssuer.certificatePem.replace(/-----[^-]+-----|\s/g, '');
    const changed = g.xml.replace(/(<X509Certificate>)[\s\S]*?(<\/X509Certificate>)/, `$1${embedded}$2`);
    expect(changed).not.toBe(g.xml);
    await expect(verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(changed), f.verifier)).rejects.toThrow('GUIDE_CDR_SIGNATURE_UNTRUSTED');
  });

  const structuralChanges: [string, (xml: string) => string][] = [
    ['other receiver', xml => xml.replace('<cbc:ID>20100070970</cbc:ID>', '<cbc:ID>20131312955</cbc:ID>')],
    ['receiver substring', xml => xml.replace('<cbc:ID>20100070970</cbc:ID>', '<cbc:ID>X20100070970</cbc:ID>')],
    ['other sender', xml => xml.replace('<cbc:ID>20131312955</cbc:ID>', '<cbc:ID>20100070970</cbc:ID>')],
    ['other reference', xml => xml.replace('<cbc:ID>TQ71-1</cbc:ID>', '<cbc:ID>TQ71-2</cbc:ID>')],
    ['other response ID', xml => xml.replace('<cbc:ReferenceID>TQ71-1</cbc:ReferenceID>', '<cbc:ReferenceID>TQ71-2</cbc:ReferenceID>')],
    ['other type', xml => xml.replace('<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>', '<cbc:DocumentTypeCode>31</cbc:DocumentTypeCode>')],
    ['missing type', xml => xml.replace('<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>', '')],
    ['duplicate type', xml => xml.replace('<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>', '<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode><cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>')],
    ['namespace alias', xml => xml.replace('<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>', '<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode><x:DocumentTypeCode xmlns:x="urn:evil">31</x:DocumentTypeCode>')],
    ['nested type', xml => xml.replace('<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>', '<cbc:DocumentTypeCode><cbc:ID>09</cbc:ID></cbc:DocumentTypeCode>')],
    ['whitespace type', xml => xml.replace('<cbc:DocumentTypeCode>09</cbc:DocumentTypeCode>', '<cbc:DocumentTypeCode> 09 </cbc:DocumentTypeCode>')],
    ['invalid code', xml => xml.replace('<cbc:ResponseCode>0</cbc:ResponseCode>', '<cbc:ResponseCode>OK</cbc:ResponseCode>')],
    ['duplicate code', xml => xml.replace('<cbc:ResponseCode>0</cbc:ResponseCode>', '<cbc:ResponseCode>0</cbc:ResponseCode><cbc:ResponseCode>0</cbc:ResponseCode>')],
    ['duplicate response', xml => xml.replace('</ApplicationResponse>', '<cac:DocumentResponse/></ApplicationResponse>')],
  ];
  it.each(structuralChanges)('rejects freshly signed mismatched CDR: %s', async (_label, mutate) => {
    const f = fixture(), changed = pki.signCdr(mutate(f.unsigned));
    await expect(verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(changed), f.verifier)).rejects.toBeInstanceOf(GuideCdrEvidenceError);
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });
  it.each([
    ['2026-10-23', '2026-02-30'], ['2026-10-23', '2026-10-22'], ['2026-10-23', '2026-10-24'],
    ['10:30:00-05:00', '09:59:59-05:00'], ['10:30:00-05:00', '11:00:01-05:00'], ['10:30:00-05:00', '24:00:00-05:00'],
    ['10:31:00-05:00', '10:29:00-05:00'], ['10:31:00-05:00', '10:31:00+15:00'],
  ])('rejects signed invalid/out-of-window CDR dates: %s -> %s', async (from, to) => {
    const f = fixture(), changed = pki.signCdr(f.unsigned.replaceAll(from, to));
    await expect(verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(changed), f.verifier)).rejects.toThrow('GUIDE_CDR_DATE_INVALID');
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });
  it('validates optional date/time pairs and supports SUNAT date-only CDRs', async () => {
    const f = fixture(), withoutDate = pki.signCdr(f.unsigned.replace('<cbc:ResponseDate>2026-10-23</cbc:ResponseDate>', ''));
    await expect(verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(withoutDate), f.verifier)).rejects.toThrow('GUIDE_CDR_DATE_INVALID');
    const dateOnly = pki.signCdr(f.unsigned.replace(/<cbc:(IssueTime|ResponseTime)>[^<]*<\/cbc:\1>/g, ''));
    expect((await verifyGuideCdrEvidence(f.expected, guideSidecarPackCdr(dateOnly), f.verifier)).signatureTrusted).toBe(true);
  });
  it.each([
    { receivedAt: '2026-10-23T14:59:59.000Z' }, { issuedAt: '2026-02-30T15:00:00Z' }, { issuedAt: '2026-10-23T10:00:00' },
    { requestXmlSha256: 'bad' }, { requestZipSha256: 'F'.repeat(64) }, { source: 'SUNAT_OFFICIAL' },
    { officialCdrVerified: true }, { signatureTrusted: true }, { transmissionAuthorized: true }, { authorizedForTransfer: true },
    { fullNumber: '../TQ71-1' }, { issuerRuc: '20100070971' }, { documentType: '01' },
  ])('rejects invalid expected context/fake flags %j', async override => {
    const f = fixture(); Object.assign(f.expected, override);
    await expect(f.run()).rejects.toThrow('GUIDE_CDR_INPUT_INVALID'); expect(f.verifier.verify).not.toHaveBeenCalled();
  });
  it('requires an actual verifier method', async () => {
    const f = fixture();
    await expect(verifyGuideCdrEvidence(f.expected, f.zip, { signatureTrusted: true } as unknown as typeof f.verifier)).rejects.toThrow('GUIDE_CDR_INPUT_INVALID');
  });
  it('does not invent cryptographic CDR binding for caller request hashes', async () => {
    const f = fixture(), first = await f.run(); f.expected.requestXmlSha256 = 'a'.repeat(64); f.expected.requestZipSha256 = 'b'.repeat(64);
    const second = await f.run();
    expect(second.cdrXmlSha256).toBe(first.cdrXmlSha256); expect(second.requestHashesBoundByCdr).toBe(false);
    expect(second.requestXmlSha256).not.toBe(first.requestXmlSha256);
  });
});

describe('guide CDR archive restrictions and await immutability', () => {
  it.each(['crc', 'size', 'local-name', 'flags', 'offset', 'trailing', 'truncated', 'zip64', 'payload'] as const)('rejects malformed ZIP %s', async kind => {
    const f = fixture(); let zip = Buffer.from(f.zip); const central = zip.readUInt32LE(zip.length - 6);
    switch (kind) {
      case 'crc': zip.writeUInt32LE(0, central + 16); break;
      case 'size': zip.writeUInt32LE(0x7fffffff, central + 24); break;
      case 'local-name': zip[30] ^= 1; break;
      case 'flags': zip.writeUInt16LE(1, central + 8); break;
      case 'offset': zip.writeUInt32LE(1, central + 42); break;
      case 'trailing': zip = Buffer.concat([zip, Buffer.from('x')]); break;
      case 'truncated': zip = zip.subarray(0, zip.length - 1); break;
      case 'zip64': zip.writeUInt32LE(0xffffffff, central + 20); break;
      case 'payload': zip[zip.indexOf(Buffer.from('FICTITIOUS LOCAL RECEIPT'))] ^= 1; break;
    }
    await expect(verifyGuideCdrEvidence(f.expected, zip, f.verifier)).rejects.toBeInstanceOf(GuideCdrEvidenceError);
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });
  it.each(['path', 'extra-file', 'oversized', 'invalid-utf8', 'malformed-xml', 'doctype'] as const)('rejects forbidden archive/XML %s', async kind => {
    const f = fixture(), name = `R-${f.expected.issuerRuc}-09-${f.expected.fullNumber}.xml`;
    let xml = Buffer.from(f.xml), files: Record<string, Uint8Array> = { [name]: xml };
    switch (kind) {
      case 'path': files = { [`../${name}`]: xml }; break;
      case 'extra-file': files['unexpected.txt'] = Buffer.from('x'); break;
      case 'oversized': files[name] = Buffer.alloc(2 * 1024 * 1024 + 1, 65); break;
      case 'invalid-utf8': xml[xml.indexOf(Buffer.from('FICTITIOUS LOCAL RECEIPT'))] = 0xff; break;
      case 'malformed-xml': files[name] = Buffer.from('<ApplicationResponse>'); break;
      case 'doctype': files[name] = Buffer.from('<!DOCTYPE root [<!ENTITY x "y">]>' + f.xml); break;
    }
    const zip = Buffer.from(zipSync(files, { level: 0 }));
    await expect(verifyGuideCdrEvidence(f.expected, zip, f.verifier)).rejects.toBeInstanceOf(GuideCdrEvidenceError);
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });
  it('allows only the existing empty dummy directory exception', async () => {
    const f = fixture(), name = `R-${f.expected.issuerRuc}-09-${f.expected.fullNumber}.xml`;
    const zip = Buffer.from(zipSync({ [name]: Buffer.from(f.xml), 'dummy/': new Uint8Array() }));
    expect((await verifyGuideCdrEvidence(f.expected, zip, f.verifier)).signatureTrusted).toBe(true);
    const bad = Buffer.from(zipSync({ [name]: Buffer.from(f.xml), 'dummy/': Buffer.from('x') }));
    await expect(verifyGuideCdrEvidence(f.expected, bad, f.verifier)).rejects.toThrow('GUIDE_CDR_ARCHIVE_INVALID');
  });
  it.each(['zip', 'expected', 'verifier-bytes'] as const)('detects mutation of %s during verifier await', async target => {
    const f = fixture(); let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { resume = r; });
    let verificationBytes!: Buffer;
    const verifier = { async verify(bytes: Buffer) { verificationBytes = bytes; entered(); await gate; return true; } };
    const pending = verifyGuideCdrEvidence(f.expected, f.zip, verifier); await ready;
    if (target === 'zip') f.zip[0] ^= 1;
    if (target === 'expected') f.expected.requestXmlSha256 = 'e'.repeat(64);
    if (target === 'verifier-bytes') verificationBytes[0] ^= 1;
    resume(); await expect(pending).rejects.toThrow('GUIDE_CDR_INPUT_CHANGED');
  });
  it('passes a copy to the verifier and preserves all caller bytes', async () => {
    const f = fixture(), zipBefore = Buffer.from(f.zip), expectedBefore: GuideCdrExpected = structuredClone(f.expected);
    await f.run(); expect(f.zip).toEqual(zipBefore); expect(f.expected).toEqual(expectedBefore);
    const bytes = f.verifier.verify.mock.calls[0][0]; expect(bytes).not.toBe(f.zip);
    expect(bytes).toEqual(Buffer.from(f.xml));
  });
});
