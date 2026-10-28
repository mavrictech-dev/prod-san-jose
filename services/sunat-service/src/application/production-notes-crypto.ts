import type { ProductionNotesAnySnapshot } from '@factuez/contracts';
import { productionNotesUnsigned, buildProductionNotesRc, productionNotesUsesRc, type ProductionNotesContext } from './production-notes-rc';
import { XmlSignerService } from '../infrastructure/crypto/xml-signer.service';
import { zipSync } from 'fflate';
/** Called inside the short-lived production-notes worker only. No network or credential lookup. */
export function prepareProductionNotesXml(note: ProductionNotesAnySnapshot, bytes: Buffer, password: string, context?: ProductionNotesContext) {
    const kind = note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote', signed = new XmlSignerService().sign(productionNotesUnsigned(note, context), bytes, password, kind);
    const fileName = note.issuer.identityNumber + '-' + note.documentTypeCode + '-' + note.fullNumber;
    const zipOf=(name:string,xml:string)=>Buffer.from(zipSync({[name+'.xml']:Buffer.from(xml)},{level:6,mtime:new Date('2020-01-01T00:00:00Z')}));
    const rc=productionNotesUsesRc(note) ? (()=>{
      if(!context?.identifier)throw Error('Reserva RC requerida');
      const unsigned=buildProductionNotesRc(note,context.identifier,context), summary=new XmlSignerService().sign(unsigned,bytes,password,'SummaryDocuments');
      return {...summary,identifier:context.identifier,fileName:note.issuer.identityNumber+'-'+context.identifier,zip:zipOf(note.issuer.identityNumber+'-'+context.identifier,summary.xml)};
    })() : undefined;
    return { ...signed, fileName, ...(rc?{rc}:{}), zip: Buffer.from(zipSync({ [fileName + '.xml']: Buffer.from(signed.xml) }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') })) };
}
