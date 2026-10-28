import type { SignedPackage } from '../../domain/ports/sunat-adapter.port';
import { validateBetaPackage } from './beta-package-validator';
import { parseCdrZip } from './cdr-parser';
import { child, leaf, safeXml, CBC_NS, CAC_NS } from './safe-xml';
import { productionTransportXml } from './production-transport-zip';

/** Same signed fiscal profile as Beta, with additional ZIP integrity checks for production.
 * This verifies local signature mathematics/identity, not PKI trust, XSD or fiscal readiness. */
export function validateProductionPackage(pkg: SignedPackage, ruc: string, method: 'sendBill' | 'sendSummary'): void {
  try {
    const { xml } = productionTransportXml(pkg.zip, pkg.fileName.replace(/\.zip$/, '.xml'));
    new TextDecoder('utf-8', { fatal: true }).decode(xml);
    validateBetaPackage(pkg, ruc, method);
  } catch { throw new Error('Paquete de producción inválido'); }
}
/** Structural CDR check only. Returning bytes never asserts acceptance or signature trust. */
export function validateProductionCdr(zip: Buffer, ruc: string, requestFileName?: string): Buffer {
  const { name, xml } = productionTransportXml(zip, requestFileName?.replace(/\.zip$/, '.xml').replace(/^/, 'R-'), true);
  const root = safeXml(new TextDecoder('utf-8', { fatal: true }).decode(xml));
  const reference = leaf(child(child(root, CAC_NS, 'DocumentResponse'), CAC_NS, 'DocumentReference'), CBC_NS, 'ID', 40);
  if (requestFileName === undefined && (!new RegExp(`^R-${ruc}-(?:RC|RA)-\\d{8}-[1-9]\\d{0,4}\\.xml$`).test(name) ||
      name !== `R-${ruc}-${reference}.xml`)) throw new Error('CDR de producción inconsistente');
  parseCdrZip(zip, { fileName: name, issuerRuc: ruc, reference: requestFileName === undefined ? reference : requestFileName.split('-').slice(2).join('-').replace(/\.zip$/, '') });
  return zip;
}
