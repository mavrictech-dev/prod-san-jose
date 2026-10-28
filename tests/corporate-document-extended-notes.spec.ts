import 'reflect-metadata';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {documentSourceFixture,documentIssuer,documentAuthorization} from './corporate-document.fixture';
import {PRODUCTION_NOTES_EXTENDED_PROFILE} from '../packages/contracts/src/production-notes';
beforeEach(()=>{vi.stubEnv('SERVER_SMTP_ENABLED','true');vi.stubEnv('SERVER_SMTP_DOCUMENTS_ENABLED','true');});
afterEach(()=>vi.unstubAllEnvs());
function receiptNote(type:'07'|'08') {
 const f=documentSourceFixture(type),s=f.doc.immutableSnapshot as any,series=type==='07'?'BC01':'BD01';
 s.profile=PRODUCTION_NOTES_EXTENDED_PROFILE;s.reference.documentTypeCode='03';s.reference.fullNumber='B001-1';s.series=series;s.fullNumber=f.doc.fullNumber=series+'-1';
 const base=documentIssuer.ruc+'-'+type+'-'+s.fullNumber,rc=documentIssuer.ruc+'-RC-20261028-7';
 for(const format of ['a4','ticket']) f.files.get(format)!.name=base+'-'+format+'-PRODUCCION.pdf';
 f.files.get('xml')!.name=base+'.xml';f.files.get('submission-zip')!.name=rc+'.zip';f.files.get('submission-zip')!.bytes=Buffer.from(f.zipSync({[rc+'.xml']:f.summary}));
 f.files.get('cdr-xml')!.name='R-'+rc+'.xml';f.files.get('cdr-zip')!.name='R-'+rc+'.zip';f.files.get('cdr-zip')!.bytes=Buffer.from(f.zipSync({['R-'+rc+'.xml']:f.cdr}));
 return f;
}
describe('extended fiscal note mail attachments',()=>{
 it.each(['07','08'] as const)('note %s on03 includes ownXML and actualRCZIP/CDR',async type=>{const f=receiptNote(type),r=await f.source.prepare(documentIssuer,f.id,'a4',documentAuthorization);expect(r.proof.referenceType).toBe('03');expect(r.attachments[1].filename).toContain('-'+type+'-B');expect(r.attachments[2].filename).toContain('-RC-');expect(r.attachments[4].filename).toContain('R-'+documentIssuer.ruc+'-RC-');});
 it.each(['07','08'] as const)('rejects individual ZIP for receipt note %s',async type=>{const f=receiptNote(type);f.files.get('submission-zip')!.name=documentIssuer.ruc+'-'+type+'-'+f.doc.fullNumber+'.zip';await expect(f.source.prepare(documentIssuer,f.id,'ticket',documentAuthorization)).rejects.toThrow();});
 it('rejects mismatchedRC archives',async()=>{const f=receiptNote('07');f.files.get('cdr-xml')!.name='R-'+documentIssuer.ruc+'-RC-20261028-99.xml';await expect(f.source.prepare(documentIssuer,f.id,'a4',documentAuthorization)).rejects.toThrow();});
 it('rejects oldgrant profile for notes on receipts',async()=>{const f=receiptNote('07');(f.doc.immutableSnapshot as any).profile='07-08-ON-01-PEN-0101-IGV18-v1';await expect(f.source.prepare(documentIssuer,f.id,'a4',documentAuthorization)).rejects.toThrow();expect(f.fetch).not.toHaveBeenCalled();});
 it('extendedinvoice discount uses ownZIP',async()=>{const f=documentSourceFixture('07'),s=f.doc.immutableSnapshot as any;s.profile=PRODUCTION_NOTES_EXTENDED_PROFILE;s.reasonCode=s.adjustment.reasonCode='05';const r=await f.source.prepare(documentIssuer,f.id,'ticket',documentAuthorization);expect(r.proof.referenceType).toBeUndefined();expect(r.attachments[2].filename).toBe(f.base+'.zip');});
});
