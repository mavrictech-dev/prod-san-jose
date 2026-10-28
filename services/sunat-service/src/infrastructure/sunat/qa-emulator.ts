// Exclusivo de Compose QA en red interna. NO es SUNAT, NO homologa documentos.
import { createServer } from 'node:http';
import { randomUUID, X509Certificate } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { SignedXml } from 'xml-crypto';
import { safeXml, child, leaf, escapeXml as x, SOAP_NS, SERVICE_NS, CBC_NS, CAC_NS } from './safe-xml';
import { base64Zip, QA_SCENARIOS, type QaScenario } from './bounded-soap.adapter';
import { RESPONSE_NS } from './cdr-parser';
import { validateNoteBillXml, validateNoteSummaryLines } from './notes-transport-qa-validator';
if (process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true') throw new Error('Emulador no autorizado');
type Record = { ruc: string; fileName: string; reference: string; scenario: QaScenario; polls: number; at: number };
const tickets = new Map<string, Record>(); const sends = new Map<string, number>();
const wsse = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const envelope = (method: string, body: string) => `<soap:Envelope xmlns:soap="${SOAP_NS}"><soap:Body><ser:${method}Response xmlns:ser="${SERVICE_NS}">${body}</ser:${method}Response></soap:Body></soap:Envelope>`;
function receipt(record: Record) {
  const code = record.scenario === 'REJECTED' ? '2335' : '0';
  const reference = record.scenario === 'INVALID_CDR' ? 'F999-999999' : record.reference;
  const xml = `<ApplicationResponse xmlns="${RESPONSE_NS}" xmlns:cbc="${CBC_NS}" xmlns:cac="${CAC_NS}"><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ID>SIMULADO-${randomUUID()}</cbc:ID><cbc:IssueDate>2026-10-01</cbc:IssueDate>${record.scenario === 'OBSERVED' ? '<cbc:Note>SIMULADO: observación de prueba</cbc:Note>' : ''}<cac:SenderParty><cac:PartyIdentification><cbc:ID>00000000000</cbc:ID></cac:PartyIdentification></cac:SenderParty><cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${record.ruc}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:Response><cbc:ResponseCode>${code}</cbc:ResponseCode><cbc:Description>SIMULADO - NO OFICIAL - ${code === '0' ? 'Aceptado por emulador local' : 'Rechazado por emulador local'}</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>${x(reference)}</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
  return Buffer.from(zipSync({ [`R-${record.fileName.replace(/\.zip$/, '.xml')}`]: Buffer.from(xml) })).toString('base64');
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', transport: 'LOCAL_SIMULATION', sends: [...sends.values()].reduce((a,b)=>a+b,0) })); return; }
  if (req.method !== 'POST' || req.url !== '/billService') { res.writeHead(404).end(); return; }
  try {
    let length = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { length += chunk.length; if (length > 6 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
    const root = safeXml(Buffer.concat(chunks).toString(), 6 * 1024 * 1024);
    if (root.namespaceURI !== SOAP_NS || root.localName !== 'Envelope') throw new Error();
    const token = child(child(child(root, SOAP_NS, 'Header'), wsse, 'Security'), wsse, 'UsernameToken');
    const username = leaf(token, wsse, 'Username', 50);
    if (!/^00\d{9}LOCALONLY$/.test(username) || leaf(token, wsse, 'Password', 100) !== 'FICTICIO-NO-SUNAT') throw new Error();
    const ruc = username.slice(0, 11); const body = child(root, SOAP_NS, 'Body');
    const method = String(req.headers.soapaction); const input = child(body, SERVICE_NS, method);
    const scenario = String(req.headers['x-factuez-qa-scenario']) as QaScenario;
    if (!QA_SCENARIOS.includes(scenario)) throw new Error();
    for (const [key, value] of tickets) if (Date.now() - value.at > 3600000) tickets.delete(key);
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    if (method === 'getStatus') {
      const record = tickets.get(leaf(input, '', 'ticket', 120));
      if (!record || record.ruc !== ruc) { res.end(envelope(method, '<status><statusCode>99</statusCode></status>')); return; }
      record.polls++;
      if (record.scenario === 'TRANSIENT_STATUS' && record.polls === 1) { res.writeHead(503).end(); return; }
      res.end(envelope(method, record.polls === 1 ? '<status><statusCode>98</statusCode></status>' : `<status><statusCode>${record.scenario === 'REJECTED' ? '99' : '0'}</statusCode><content>${receipt(record)}</content></status>`)); return;
    }
    if (!['sendBill','sendSummary'].includes(method)) throw new Error();
    const fileName = leaf(input, '', 'fileName', 120);
    if (!fileName.startsWith(`${ruc}-`) || !/^[A-Za-z0-9_-]+\.zip$/.test(fileName) || sends.size > 1000 || tickets.size > 500) throw new Error();
    let entries = 0;
    const files = unzipSync(base64Zip(leaf(input, '', 'contentFile', 6 * 1024 * 1024)), { filter: file => { if (++entries !== 1 || file.name !== fileName.replace(/\.zip$/, '.xml') || file.originalSize > 2 * 1024 * 1024) throw new Error(); return true; } });
    if (entries !== 1) throw new Error();
    const xml = Buffer.from(Object.values(files)[0]).toString(); const document = safeXml(xml);
    const billType = method === 'sendBill' ? fileName.split('-')[1] : undefined;
    if (method === 'sendBill' && !['01', '07', '08'].includes(billType!)) throw new Error();
    const rootKind = method === 'sendBill' ? billType === '07' ? 'CreditNote' : billType === '08' ? 'DebitNote' : 'Invoice' : fileName.startsWith(`${ruc}-RA-`) ? 'VoidedDocuments' : 'SummaryDocuments';
    const rootNamespace = method === 'sendBill' ? `urn:oasis:names:specification:ubl:schema:xsd:${rootKind}-2` : `urn:sunat:names:specification:ubl:peru:schema:xsd:${rootKind}-1`;
    if (document.localName !== rootKind || document.namespaceURI !== rootNamespace) throw new Error();
    const signatures = document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature'); if (signatures.length !== 1) throw new Error();
    const certs = signatures[0].getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate'); if (certs.length !== 1) throw new Error();
    const cert = new X509Certificate(Buffer.from(certs[0].textContent ?? '', 'base64')); if (!cert.verify(cert.publicKey)) throw new Error();
    const verifier = new SignedXml({ publicCert: cert.toString(), getCertFromKeyInfo: () => null }); verifier.loadSignature(signatures[0]);
    if (!verifier.checkSignature(xml) || verifier.getSignedReferences().length !== 1) throw new Error();
    const trusted = safeXml(verifier.getSignedReferences()[0]); const reference = leaf(trusted, CBC_NS, 'ID', 40);
    const supplier = child(trusted, CAC_NS, 'AccountingSupplierParty');
    const actualRuc = method === 'sendBill' ? leaf(child(child(supplier, CAC_NS, 'Party'), CAC_NS, 'PartyIdentification'), CBC_NS, 'ID', 11) : leaf(supplier, CBC_NS, 'CustomerAssignedAccountID', 11);
    if (actualRuc !== ruc || fileName !== `${ruc}-${method === 'sendBill' ? `${billType}-` : ''}${reference}.zip`) throw new Error();
    if (billType === '07' || billType === '08') validateNoteBillXml(verifier.getSignedReferences()[0], fileName, ruc);
    if (rootKind === 'SummaryDocuments') validateNoteSummaryLines(trusted);
    const record = { ruc, fileName, reference, scenario, polls: 0, at: Date.now() };
    const sendsKey = `${ruc}:${fileName}`; sends.set(sendsKey, (sends.get(sendsKey) ?? 0) + 1);
    if (scenario === 'UNCERTAIN') { req.socket.destroy(); return; } // Recibido, respuesta perdida.
    if (method === 'sendSummary') { const ticket = `LOCAL-${randomUUID()}`; tickets.set(ticket, record); res.end(envelope(method, `<ticket>${ticket}</ticket>`)); }
    else res.end(envelope(method, `<applicationResponse>${receipt(record)}</applicationResponse>`));
  } catch { if (!res.headersSent) res.writeHead(400); res.end('Solicitud QA inválida'); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(3006, '0.0.0.0');
