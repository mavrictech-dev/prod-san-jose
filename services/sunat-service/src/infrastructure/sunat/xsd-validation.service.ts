import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { readFile, mkdtemp, mkdir, writeFile, realpath, stat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { safeXml } from './safe-xml';
import { LocalPreparationUnavailableError } from '../../application/local-preparation-policy';

export const XSD_PROFILE = 'SUNAT-XSD-20220228-SHA5cac9d93-v1';
export const XSD_ARCHIVE_SHA256 = '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5';
export type XsdDocumentKind = 'Invoice' | 'SummaryDocuments' | 'VoidedDocuments' | 'CreditNote' | 'DebitNote' | 'DespatchAdvice';
type Kind = XsdDocumentKind;
const NAMESPACES: Record<Kind, string> = {
  Invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  CreditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  DebitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  DespatchAdvice: 'urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2',
  SummaryDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1',
  VoidedDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1',
};
const ENTRY: Record<Kind, string> = {
  Invoice: '2.1/maindoc/UBL-Invoice-2.1.xsd',
  CreditNote: '2.1/maindoc/UBL-CreditNote-2.1.xsd',
  DebitNote: '2.1/maindoc/UBL-DebitNote-2.1.xsd',
  DespatchAdvice: '2.1/maindoc/UBL-DespatchAdvice-2.1.xsd',
  SummaryDocuments: '2.0/maindoc/UBLPE-SummaryDocuments-1.0.xsd',
  VoidedDocuments: '2.0/maindoc/UBLPE-VoidedDocuments-1.0.xsd',
};
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function inside(root: string, candidate: string) { const name = relative(root, candidate); return name !== '' && !name.startsWith('..') && !isAbsolute(name); }

/** Paquete fijo, sólo imports locales y proceso acotado. Nunca homologa reglas SUNAT. */
@Injectable()
export class XsdValidationService {
  private preparing?: Promise<Record<Kind, string>>;
  private active = 0;
  private bundle() {
    return this.preparing ??= this.extract().catch((error: unknown) => {
      this.preparing = undefined;
      // Sólo fallos de recursos locales. Hash, estructura y referencias inseguras
      // conservan un error permanente, aunque también respondan HTTP 503.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (typeof code === 'string' && ['ENOENT', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOSPC', 'EIO', 'ETIMEDOUT'].includes(code)) {
        throw new LocalPreparationUnavailableError('Paquete XSD oficial no disponible temporalmente');
      }
      throw new ServiceUnavailableException('Paquete XSD oficial no disponible o inconsistente');
    });
  }
  private async extract(): Promise<Record<Kind, string>> {
    const archive = join(__dirname, '../../../assets/sunat/xsd-20220228.zip');
    const file = await stat(archive);
    if (!file.isFile() || file.size !== 609363) throw new Error();
    const bytes = await readFile(archive);
    if (sha(bytes) !== XSD_ARCHIVE_SHA256) throw new Error();
    // El hash se comprueba ANTES de descomprimir; no admite ZIP subidos por usuarios.
    const files = unzipSync(bytes); const entries = Object.entries(files).filter(([name]) => name.endsWith('.xsd'));
    if (!entries.length || entries.length > 128) throw new Error();
    if (Object.values(ENTRY).some(entry => !Object.hasOwn(files, `Archivos XSD/${entry}`))) throw new Error();
    const directory = await mkdtemp(join(tmpdir(), 'factuez-xsd-'));
    const root = await realpath(directory); let total = 0;
    for (const [name, content] of entries) {
      if (!/^Archivos XSD\/(?:2\.0|2\.1)\/[A-Za-z0-9_./-]+\.xsd$/.test(name) || content.length > 5 * 1024 * 1024 || (total += content.length) > 32 * 1024 * 1024) throw new Error();
      const target = resolve(root, name.slice('Archivos XSD/'.length));
      if (!inside(root, target)) throw new Error();
      const xml = Buffer.from(content).toString('utf8');
      let inspection = xml.replace(/<!--[\s\S]*?-->/g, '');
      // Excepción EXACTA del schema W3C incluido en el ZIP fijado: DTD interno
      // sin PUBLIC/SYSTEM. Se conserva el archivo oficial byte a byte para libxml.
      // Esta excepción jamás se aplica al XML de comprobantes, que rechaza todo DTD.
      const internal = inspection.match(/<!DOCTYPE\s+schema\s*\[[\s\S]*?\]>/)?.[0];
      if (internal) {
        const allowed = `<!DOCTYPE schema [ <!ATTLIST schema xmlns:ds CDATA #FIXED "http://www.w3.org/2000/09/xmldsig#"> <!ENTITY dsig 'http://www.w3.org/2000/09/xmldsig#'> <!ENTITY % p ''> <!ENTITY % s ''> ]>`;
        if (name !== 'Archivos XSD/2.1/common/UBL-xmldsig-core-schema-2.1.xsd' || internal.replace(/\s+/g, ' ').trim() !== allowed) throw new Error();
        inspection = inspection.replace(internal, '');
      }
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(inspection)) throw new Error();
      const doc = new DOMParser({ onError: () => { throw new Error(); } }).parseFromString(inspection, 'application/xml');
      // No se confía en --nonet por sí solo: se prohíben referencias externas en el paquete.
      const nodes = Array.from(doc.getElementsByTagName('*'));
      for (const node of nodes) {
        if (node.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base')) throw new Error();
        if (node.namespaceURI === 'http://www.w3.org/2001/XMLSchema' && ['import','include','redefine'].includes(node.localName ?? '')) {
          const location = node.getAttribute('schemaLocation');
          if (location && (!/^[A-Za-z0-9_./-]+\.xsd$/.test(location) || !inside(root, resolve(dirname(target), location)))) throw new Error();
        }
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
    const paths = Object.fromEntries(Object.entries(ENTRY).map(([kind, entry]) => [kind, join(root, entry)])) as Record<Kind, string>;
    for (const path of Object.values(paths)) if (!inside(root, await realpath(path))) throw new Error();
    // Sólo contiene schemas públicos, no XML de clientes ni certificados. Docker elimina
    // el temporal propio al recrear el contenedor; nunca se borra un directorio del usuario.
    return paths;
  }
  async configured(): Promise<boolean> {
    try { await this.bundle(); await access('/usr/bin/xmllint', constants.X_OK); return true; } catch { return false; }
  }
  async validate(input: string | Buffer, kind: Kind) {
    if (!Object.hasOwn(NAMESPACES, kind)) throw new BadRequestException('Perfil XSD desconocido');
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let root;
    try {
      root = safeXml(bytes.toString('utf8'));
      if (root.localName !== kind || root.namespaceURI !== NAMESPACES[kind]) throw new Error();
      for (const node of Array.from(root.getElementsByTagName('*')).concat(root)) {
        if (node.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base') ||
          node.hasAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'schemaLocation') ||
          node.hasAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'noNamespaceSchemaLocation') ||
          node.namespaceURI === 'http://www.w3.org/2001/XInclude') throw new Error();
      }
    } catch { throw new BadRequestException('XML fuera del perfil XSD o con referencias externas'); }
    if (this.active >= 2) throw new LocalPreparationUnavailableError('Validador XSD ocupado; reintente');
    this.active++;
    try {
      const schema = (await this.bundle())[kind];
      await this.run(bytes, schema);
      return { profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256, xmlSha256: sha(bytes), verifiedAt: new Date().toISOString() };
    } finally { this.active--; }
  }
  private run(bytes: Buffer, schema: string): Promise<void> {
    return new Promise((done, fail) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('/usr/bin/xmllint', ['--nonet','--nocatalogs','--noout','--maxmem','134217728','--schema',schema,'-'],
          { shell: false, stdio: ['pipe','pipe','pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', XML_CATALOG_FILES: '', SGML_CATALOG_FILES: '' } });
      } catch { fail(new LocalPreparationUnavailableError('Validador XSD no disponible')); return; }
      let settled = false; let output = 0; let inputFailed = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); fail(error); } else done(); };
      const timer = setTimeout(() => finish(new LocalPreparationUnavailableError('Validación XSD excedió el límite seguro')), 5000);
      const boundedOutput = (chunk: Buffer) => { output += chunk.length; if (output > 65536) finish(new BadRequestException('XML rechazado por XSD oficial')); };
      child.stdout!.on('data', boundedOutput); child.stderr!.on('data', boundedOutput);
      child.once('error', () => finish(new LocalPreparationUnavailableError('Validador XSD no disponible')));
      child.once('close', code => finish(code === 0 && !inputFailed ? undefined : code === null
        ? new LocalPreparationUnavailableError('Validador XSD interrumpido') : new BadRequestException('XML rechazado por XSD oficial')));
      // EPIPE también aparece cuando xmllint rechaza XML: decide el código de
      // salida (o error/timeout del proceso), no el cierre anticipado de stdin.
      child.stdin!.on('error', () => { inputFailed = true; });
      child.stdin!.end(bytes);
    });
  }
}
