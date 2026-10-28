import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { buildInvoiceUbl, validateLocalInvoice, LOCAL_XML_PROFILE } from '@factuez/sunat-core';
import { zipSync, unzipSync } from 'fflate';
import { XmlSignerService } from './xml-signer.service';

export function prepareLocalXml(snapshot: FiscalDocumentSnapshot, bytes: Buffer, password: string) {
  validateLocalInvoice(snapshot, { allowCredit: true });
  const unsignedXml = buildInvoiceUbl(snapshot);
  const signed = new XmlSignerService().sign(unsignedXml, bytes, password);
  const fileName = `${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.series}-${snapshot.number}`;
  const xmlBytes = Buffer.from(signed.xml, 'utf8');
  const zip = Buffer.from(zipSync({ [`${fileName}.xml`]: xmlBytes }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') }));
  const extracted = unzipSync(zip);
  if (Object.keys(extracted).length !== 1 || !Buffer.from(extracted[`${fileName}.xml`]).equals(xmlBytes)) throw new Error('ZIP local inválido');
  return { ...signed, fileName, zip, profile: LOCAL_XML_PROFILE };
}
