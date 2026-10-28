import { DOMParser } from '@xmldom/xmldom';
export const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
export const SERVICE_NS = 'http://service.sunat.gob.pe';
export const CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
export const CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
export function escapeXml(value: string) {
  if (typeof value !== 'string' || /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) throw new Error('Texto XML inválido');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
export function safeXml(xml: string, maxBytes = 2 * 1024 * 1024) {
  if (!xml || Buffer.byteLength(xml) > maxBytes || /<!|<\?(?!xml\s)/i.test(xml)) throw new Error('XML no permitido');
  const doc = new DOMParser({ onError: () => { throw new Error('XML mal formado'); } }).parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root) throw new Error('Raíz XML ausente');
  let count = 0; const pending = [{ node: root, depth: 1 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 30000 || depth > 40) throw new Error('Complejidad XML excedida');
    for (let n = node.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) pending.push({ node: n as typeof root, depth: depth + 1 });
  }
  return root;
}
type XmlElement = ReturnType<typeof safeXml>;
export function children(parent: XmlElement, ns: string, name: string) {
  const result: XmlElement[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) {
    const el = n as XmlElement; if ((el.namespaceURI ?? '') === ns && el.localName === name) result.push(el);
  }
  return result;
}
export function child(parent: XmlElement, ns: string, name: string) {
  const nodes = children(parent, ns, name); if (nodes.length !== 1) throw new Error('Nodo XML ausente o ambiguo'); return nodes[0];
}
export function leaf(parent: XmlElement, ns: string, name: string, max = 2048) {
  const el = child(parent, ns, name);
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) throw new Error('Texto XML ambiguo');
  const text = el.textContent?.trim() ?? ''; if (!text || text.length > max) throw new Error('Texto XML fuera de límite'); return text;
}
