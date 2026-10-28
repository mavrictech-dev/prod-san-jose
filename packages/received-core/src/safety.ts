import { DOMParser, type Element } from '@xmldom/xmldom';
import { TextDecoder } from 'node:util';

export const MiB = 1024 * 1024;
export const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
export const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
export const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
export const SAC = 'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1';
export const DS = 'http://www.w3.org/2000/09/xmldsig#';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const ROOTS = new Set(['Invoice', 'CreditNote', 'DebitNote', 'DespatchAdvice', 'Perception', 'Retention', 'ApplicationResponse']);

export class ReceivedCoreError extends Error {
  constructor(message: string) { super(message); this.name = 'ReceivedCoreError'; }
}
export function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ReceivedCoreError(message);
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ReceivedCoreError('UTF-8 inválido'); }
}
export function children(parent: Element): Element[] {
  const result: Element[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) result.push(n as Element);
  return result;
}

/** Byte bounded, no I/O, no entity declarations, XInclude or external resolution.
 * The lexical limit precedes DOM construction, including for unknown subtrees. */
export function safeReceivedXml(bytes: Uint8Array): Element {
  ensure(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 2 * MiB, 'XML excede 2 MiB o está vacío');
  let xml = utf8(bytes);
  ensure(!/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(xml), 'Caracteres XML inválidos');
  const declaration = /^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>/i.exec(xml);
  if (declaration) xml = xml.slice(declaration[0].length);
  // Comments and CDATA may contain literal '<?' or '<!'; only actual markup is checked.
  const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  ensure(!/<\?|<!/i.test(markup), 'XML con DTD, entidades o instrucciones no permitido');
  let depth = 0, count = 0;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_](?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of xml.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { ensure(--depth >= 0, 'XML mal formado'); continue; }
    ensure(++count <= 15000 && ++depth <= 32, 'Complejidad XML excedida');
    if (/\/\s*>$/.test(token)) depth--;
  }
  ensure(depth === 0, 'XML mal formado');
  let document;
  try { document = new DOMParser({ onError: () => { throw new Error(); } }).parseFromString(xml, 'application/xml'); }
  catch { throw new ReceivedCoreError('XML mal formado'); }
  const root = document.documentElement;
  ensure(root, 'Raíz XML ausente');
  for (let n = document.firstChild; n; n = n.nextSibling) {
    ensure(n === root || n.nodeType === 8 || n.nodeType === 3 && !n.nodeValue?.trim(), 'Raíz XML ambigua');
  }
  const ids = new Set<string>(), pending = [{ node: root, depth: 1 }]; count = 0;
  while (pending.length) {
    const { node, depth: level } = pending.pop()!;
    ensure(++count <= 15000 && level <= 32 && node.attributes.length <= 32, 'Complejidad XML excedida');
    ensure(node === root || !ROOTS.has(node.localName ?? ''), 'Documento XML anidado no permitido');
    ensure(node.namespaceURI !== 'http://www.w3.org/2001/XInclude', 'Referencia externa XML no permitida');
    for (let i = 0; i < node.attributes.length; i++) {
      const a = node.attributes.item(i)!;
      ensure(a.value.length <= 4096, 'Atributo XML excede límite');
      if (a.namespaceURI === XMLNS) continue;
      ensure(!(a.namespaceURI === 'http://www.w3.org/XML/1998/namespace' && a.localName === 'base') &&
        !(a.namespaceURI === 'http://www.w3.org/2001/XMLSchema-instance' && ['schemaLocation', 'noNamespaceSchemaLocation', 'type', 'nil'].includes(a.localName!)), 'Referencia externa o tipo XML no permitido');
      if (['ID', 'Id', 'id'].includes(a.localName!)) {
        ensure(a.value.length > 0 && !ids.has(a.value), 'Identificador XML duplicado'); ids.add(a.value);
      }
      if (['href', 'src'].includes(a.localName!) || node.namespaceURI === DS && a.localName === 'URI') {
        ensure(a.value === '' || /^#[A-Za-z_][\w.:-]*$/.test(a.value), 'Referencia externa XML no permitida');
      }
    }
    for (let n = node.firstChild; n; n = n.nextSibling) {
      ensure([1, 3, 4, 8].includes(n.nodeType), 'Nodo XML no permitido');
      if (n.nodeType === 1) pending.push({ node: n as Element, depth: level + 1 });
    }
  }
  const signatures = document.getElementsByTagNameNS(DS, 'Signature');
  ensure(signatures.length <= 1, 'Firma XML ambigua');
  for (let i = 0; i < signatures.length; i++) {
    const signature = signatures.item(i)!, content = signature.parentNode as Element,
      extension = content?.parentNode as Element, extensions = extension?.parentNode as Element;
    ensure(content?.namespaceURI === EXT && content.localName === 'ExtensionContent' &&
      extension?.namespaceURI === EXT && extension.localName === 'UBLExtension' &&
      extensions?.namespaceURI === EXT && extensions.localName === 'UBLExtensions' && extensions.parentNode === root, 'Ubicación de firma XML inválida');
    const nodes = [signature];
    while (nodes.length) {
      const node = nodes.pop()!;
      ensure(node.namespaceURI === DS, 'Contenido de firma XML no permitido');
      ensure(node.localName !== 'Object' && node.localName !== 'Manifest' && node.localName !== 'RetrievalMethod', 'Contenedor de firma XML no permitido');
      if (node.localName === 'Reference') {
        const uri = node.getAttribute('URI');
        ensure(uri !== null && (uri === '' || root.getAttribute('Id') === uri.slice(1) || root.getAttribute('ID') === uri.slice(1) || root.getAttribute('id') === uri.slice(1)), 'Referencia de firma ajena a la raíz');
      }
      nodes.push(...children(node));
    }
  }
  return root;
}
