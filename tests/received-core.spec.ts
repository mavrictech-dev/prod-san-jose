import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { parseReceivedXml, unpackReceivedFiles, validateReceivedCdr } from '../packages/received-core/src/index';
import { receivedXml, receivedCdr } from './received-fixture.mjs';
const require = createRequire(new URL('../packages/received-core/package.json', import.meta.url));
const AdmZip = require('adm-zip');
const bytes = (text: string) => Buffer.from(text);
describe('Reception XML projection: original evidence, not emission', () => {
  it.each([['20', 'Retention'], ['40', 'Perception']])('preserves %s agent identity/references without inventing sale items or totals', (type, root) => {
    const xml = `<${root} xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:${root}-1" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1"><cbc:ID>RQA1-1</cbc:ID><cbc:IssueDate>2026-01-01</cbc:IssueDate><cac:AgentParty><cac:PartyIdentification><cbc:ID schemeID="6">00000000303</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>AGENTE FICTICIO</cbc:RegistrationName></cac:PartyLegalEntity></cac:AgentParty><cac:ReceiverParty><cac:PartyIdentification><cbc:ID schemeID="6">00000000101</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cbc:TotalInvoiceAmount currencyID="PEN">3.00</cbc:TotalInvoiceAmount><sac:SUNAT${root}DocumentReference><cbc:ID schemeID="01">FQA1-1</cbc:ID><cbc:TotalInvoiceAmount currencyID="PEN">100.00</cbc:TotalInvoiceAmount></sac:SUNAT${root}DocumentReference></${root}>`;
    const p = parseReceivedXml(bytes(xml)); expect(p.documentType).toBe(type); expect(p.supplier.identityNumber).toBe('00000000303');
    expect(p.recipient.identityNumber).toBe('00000000101'); expect(p.references[0].number).toBe('FQA1-1'); expect(p.items).toEqual([]);
    expect(p.totals.payableAmount).toBeNull(); expect(p.warnings.some(w => w.includes('Totales/régimen'))).toBe(true);
  });
  it.each(['01', '03', '07', '08', '09', '31'])('reads complete commercial line and payment metadata for %s', type => {
    const original = bytes(receivedXml(type)); const p = parseReceivedXml(original);
    expect(p.documentType).toBe(type); expect(p.recipient.identityNumber).toBe('00000000101');
    expect(p.items[0]).toMatchObject({ supplierCode: 'QA-1', sunatCode: '15101506', quantity: '5.000', unitValue: '20.000000', unitPrice: '23.60', lineExtensionAmount: '100.00', description: 'Combustible ficticio & detalle' });
    expect(p.items[0].taxes[0]).toMatchObject({ amount: '18.00', taxableAmount: '100.00', percent: '18', affectationCode: '10' });
    expect(p.paymentTerms[0]).toMatchObject({ amount: '118.00', dueDate: '2026-02-01' });
    expect(p.xmlSha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(p.signature).toEqual({ status: 'MISSING', officialTrust: false });
  });
  it('retains unknown fields in original with a qualified warning, not fabricated values', () => {
    const p = parseReceivedXml(bytes(receivedXml().replace('</Invoice>', '<cbc:Unknown>Original only</cbc:Unknown></Invoice>')));
    expect(p.warnings.some(w => w.includes('Unknown'))).toBe(true);
  });
  it('does not convert unknown tax rates into IGV18', () => {
    const p = parseReceivedXml(bytes(receivedXml().replaceAll('<cbc:Percent>18', '<cbc:Percent>7.50')));
    expect(p.items[0].taxes[0].percent).toBe('7.50'); expect(p.warnings.some(w => w.includes('sin normalizar'))).toBe(true);
  });
  it.each([
    (s: string) => s.replace('<Invoice ', '<Invoice xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="https://external.invalid/schema" '),
    (s: string) => s.replace('<Invoice ', '<Invoice xml:base="https://external.invalid/" '),
    (s: string) => s.replace('<cbc:ID>FQA1-00000001</cbc:ID>', '<cbc:ID>FQA1-1</cbc:ID><cbc:ID>FQA1-2</cbc:ID>'),
    (s: string) => s.replace('<cbc:IssueDate>2026-01-01', '<cbc:IssueDate>2026-02-30'),
    (s: string) => s.replace('<cbc:InvoiceTypeCode>01', '<cbc:InvoiceTypeCode>99'),
    (s: string) => s.replace('<cbc:ID schemeID="6">00000000303', '<cbc:ID schemeID="6">bad'),
    (s: string) => s.replace('</Invoice>', '<Invoice/></Invoice>'),
    (s: string) => s.replace('</Invoice>', '<?unsafe x?></Invoice>'),
    (s: string) => s.replace('</Invoice>', '<a xmlns="http://www.w3.org/2001/XInclude"/></Invoice>'),
    (s: string) => s.replace('<cac:InvoiceLine>', '<cac:InvoiceLine id="same"><a id="same"/>'),
  ])('rejects ambiguous or external XML %#', transform => expect(() => parseReceivedXml(bytes(transform(receivedXml())))).toThrow());
  it('rejects DTD/entity expansion and invalid UTF-8', () => {
    expect(() => parseReceivedXml(bytes('<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///secret">]>' + receivedXml()))).toThrow();
    expect(() => parseReceivedXml(Buffer.from([255, 254, 128]))).toThrow();
  });
  it('accepts comments/CDATA but bounds XML bytes, depth, duplicate lines', () => {
    expect(parseReceivedXml(bytes(receivedXml().replace('Combustible ficticio &amp; detalle', '<![CDATA[ literal <! harmless ]]>'))).items[0].description).toContain('harmless');
    expect(() => parseReceivedXml(Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow();
    const s = receivedXml(); const line = s.match(/<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/)![0];
    expect(() => parseReceivedXml(bytes(s.replace('</Invoice>', `${line}</Invoice>`)))).toThrow();
    expect(() => parseReceivedXml(bytes('<Invoice>' + '<a>'.repeat(40) + '</a>'.repeat(40) + '</Invoice>'))).toThrow();
  });
});
describe('CDR: matching evidence cannot certify acceptance', () => {
  const p = parseReceivedXml(bytes(receivedXml()));
  it('matches reference including zero-padded correlativo, returns no status', () => expect(validateReceivedCdr(bytes(receivedCdr('FQA1-1')), p)).toBeUndefined());
  it.each([receivedCdr('FQA1-2'), receivedCdr('FQA1-1', '03'), receivedCdr().replace('DocumentReference', 'Other'), '<ApplicationResponse/>'])('rejects mismatched CDR', cdr => expect(() => validateReceivedCdr(bytes(cdr), p)).toThrow());
});
describe('ZIP reception: bounded and never extracted to disk', () => {
  const zip = (name: string, data = bytes(receivedXml())) => { const z = new AdmZip(); z.addFile(name, data); return z.toBuffer(); };
  it('reads flat XML and exact bytes', () => {
    const s = bytes(receivedXml()); expect(unpackReceivedFiles([{ fileName: 'sample.zip', bytes: zip('sample.xml', s) }])[0].bytes.equals(s)).toBe(true);
  });
  it.each(['folder/sample.xml', 'folder\\sample.xml', 'CON.xml', 'sample.zip', 'sample.exe'])('rejects unsafe entry %s', name => expect(() => unpackReceivedFiles([{ fileName: 'sample.zip', bytes: zip(name) }])).toThrow());
  it('rejects traversal in raw ZIP headers (zip writers sanitize traversal names)', () => {
    const raw = zip('xx/sample.xml');
    for (let index = raw.indexOf('xx/sample.xml'); index !== -1; index = raw.indexOf('xx/sample.xml', index + 1)) raw.write('../sample.xml', index);
    expect(() => unpackReceivedFiles([{ fileName: 'sample.zip', bytes: raw }])).toThrow();
  });
  it('rejects duplicates before decompressing and ZIP bombs', () => {
    const z = new AdmZip(); z.addFile('a.xml', bytes(receivedXml())); z.addFile('A.xml', bytes(receivedXml()));
    expect(() => unpackReceivedFiles([{ fileName: 'sample.zip', bytes: z.toBuffer() }])).toThrow();
    expect(() => unpackReceivedFiles([{ fileName: 'sample.zip', bytes: zip('bomb.xml', Buffer.alloc(2 * 1024 * 1024, 32)) }])).toThrow();
  });
  it('rejects CRC corruption, hidden data and encrypted flags', () => {
    const valid = zip('sample.xml'); const crc = Buffer.from(valid); crc.writeUInt32LE(1, 14);
    expect(() => unpackReceivedFiles([{ fileName: 'sample.zip', bytes: crc }])).toThrow();
    expect(() => unpackReceivedFiles([{ fileName: 'sample.zip', bytes: Buffer.concat([valid, bytes('hidden')]) }])).toThrow();
    const encrypted = Buffer.from(valid); encrypted.writeUInt16LE(1, 6);
    expect(() => unpackReceivedFiles([{ fileName: 'sample.zip', bytes: encrypted }])).toThrow();
  });
});
