import type { Element } from '@xmldom/xmldom';
import type { ReceivedDocumentProjectionV1, ReceivedParty } from '@factuez/contracts';
import { CBC, CAC, children, ensure, safeReceivedXml } from './safety';

/** Validates attachment identity only. ResponseCode (even 0) conveys no local
 * signature verification, official trust, ownership authorization or acceptance. */
export function validateReceivedCdr(bytes: Uint8Array, projection: ReceivedDocumentProjectionV1): void {
  const root = safeReceivedXml(bytes);
  ensure(root.localName === 'ApplicationResponse' && root.namespaceURI === 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2', 'Raíz/namespace CDR no soportado');
  function many(parent: Element, name: string, ns = CAC) {
    const nodes = children(parent).filter(n => n.localName === name);
    ensure(nodes.every(n => n.namespaceURI === ns) && nodes.length <= 100, `Nodos CDR inválidos: ${name}`); return nodes;
  }
  function one(parent: Element, name: string, ns = CAC, required = false) {
    const nodes = many(parent, name, ns); ensure(nodes.length <= 1 && (!required || nodes.length === 1), `Nodo CDR ausente o ambiguo: ${name}`); return nodes[0] ?? null;
  }
  function text(node: Element | null): string | null {
    if (!node) return null;
    ensure(children(node).length === 0, 'Texto CDR ambiguo'); const value = (node.textContent ?? '').trim();
    ensure(value.length > 0 && value.length <= 4096, 'Texto CDR inválido'); return value;
  }
  function numberMatches(value: string | null) {
    if (value === null) return false;
    const expected = /^([A-Za-z0-9]{1,8})-(\d{1,12})$/.exec(projection.fullNumber), actual = /^([A-Za-z0-9]{1,8})-(\d{1,12})$/.exec(value);
    return expected !== null && actual !== null && expected[1] === actual[1] && BigInt(expected[2]) === BigInt(actual[2]);
  }
  function partyIdentity(node: Element | null, expected: ReceivedParty) {
    if (!node) return;
    // CDR parties are PartyType directly, not AccountingSupplierParty wrappers.
    const partyIds = many(node, 'PartyIdentification');
    for (const partyId of partyIds) {
      const id = one(partyId, 'ID', CBC, true)!;
      ensure(text(id) === expected.identityNumber, 'Identidad de parte CDR no coincide');
      if (id.hasAttribute('schemeID')) ensure(id.getAttribute('schemeID') === expected.identityType, 'Tipo de identidad CDR no coincide');
    }
    const legal = one(node, 'PartyLegalEntity');
    if (legal) {
      const company = one(legal, 'CompanyID', CBC);
      if (company) {
        ensure(text(company) === expected.identityNumber, 'Identidad legal CDR no coincide');
        if (company.hasAttribute('schemeID')) ensure(company.getAttribute('schemeID') === expected.identityType, 'Tipo de identidad legal CDR no coincide');
      }
    }
  }
  // Root SenderParty is the response authority (SUNAT/OSE), not the supplier.
  // Root ReceiverParty identifies the document issuer receiving that response.
  partyIdentity(one(root, 'ReceiverParty'), projection.supplier);
  const responses = many(root, 'DocumentResponse');
  ensure(responses.length === 1, 'CDR requiere una respuesta de documento');
  const response = responses[0], reference = one(response, 'DocumentReference', CAC, true)!;
  const id = one(reference, 'ID', CBC, true)!;
  ensure(numberMatches(text(id)), 'Número de documento CDR no coincide');
  const type = text(one(reference, 'DocumentTypeCode', CBC)), typeAttribute = id.getAttribute('schemeID');
  if (type !== null) ensure(type === projection.documentType, 'Tipo de documento CDR no coincide');
  if (typeAttribute !== null && typeAttribute !== '') ensure(typeAttribute === projection.documentType, 'Tipo de documento CDR no coincide');
  const result = one(response, 'Response');
  if (result) {
    const referenceId = text(one(result, 'ReferenceID', CBC));
    if (referenceId !== null) ensure(numberMatches(referenceId), 'Referencia de respuesta CDR no coincide');
  }
  partyIdentity(one(response, 'IssuerParty'), projection.supplier);
  partyIdentity(one(response, 'RecipientParty'), projection.recipient);
}
