import 'reflect-metadata';
import { beforeAll,describe,it,expect,vi,afterEach } from 'vitest';
import { randomUUID,generateKeyPairSync,createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildNoteQaSnapshot,validateNoteQaSnapshot,noteQaCanonical } from '../packages/sunat-core/src/notes-qa';
import { buildNoteQaUbl } from '../packages/sunat-core/src/notes-ubl';
import { buildGreQaUbl,validateGreQaInput,GRE_QA_PROFILE } from '../packages/sunat-core/src/gre-ubl';
import { validateFiscalSnapshot,isFiscalTimestamp,isRucStructurallyValid } from '../packages/sunat-core/src/fiscal-rules';
import { buildBatchQaXml,validateBatchQa } from '../services/sunat-service/src/infrastructure/crypto/local-batch';
import { parseBatchQaRequest,FiscalBatchQaService } from '../services/sunat-service/src/application/fiscal-batch-qa.service';
import { NotesQaService } from '../services/sunat-service/src/application/notes-qa.service';
import { GreQaService } from '../services/sunat-service/src/application/gre-qa.service';
import { SunatGreRestAdapter } from '../services/sunat-service/src/infrastructure/sunat/sunat-gre-rest.adapter';
import { XmlSignerService,verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { CertificateTrustService } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { assertOfficialFiscalActivation } from '../services/sunat-service/src/application/fiscal-readiness.service';
import { prepareNotesQaXml } from '../services/sunat-service/src/application/notes-qa-pipeline';
import { verifyNotesTransportPackage } from '../services/sunat-service/src/application/notes-transport-qa-package';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
const require=createRequire(new URL('../services/sunat-service/package.json',import.meta.url));const forge=require('node-forge');const {ConflictException,UnauthorizedException}=require('@nestjs/common');
const original: FiscalDocumentSnapshot={documentId:randomUUID(),environment:'BETA',documentTypeCode:'01',series:'FQ01',number:'1',fullNumber:'FQ01-1',issueDate:'2026-10-01T16:00:00Z',currencyCode:'PEN',operationTypeCode:'0101',issuer:{identityType:'6',identityNumber:'00000000001',legalName:'EMISOR FICTICIO',ubigeo:'150101',establishmentCode:'0001'},customer:{identityType:'6',identityNumber:'00000000000',legalName:'CLIENTE QA'},...calculateDocumentTotals([{description:'Ítem de prueba <&>',unitCode:'NIU',quantity:'2',unitPriceWithTax:'11.80',taxAffectationCode:'10',igvRate:'18'}])};
const receipt=(number:number)=>({...structuredClone(original),documentId:randomUUID(),documentTypeCode:'03',series:'BQ01',number:String(number),fullNumber:`BQ01-${number}`,customer:{identityType:'0',identityNumber:'0',legalName:'CLIENTE QA'}});
const note=(type:'07'|'08',reason:string)=>buildNoteQaSnapshot(original,{idempotencyKey:randomUUID(),documentTypeCode:type,reasonCode:reason,reasonDescription:'Ajuste ficticio & <local>',...(type==='08'?{lines:[{originalLineNumber:1,quantity:'1',unitPriceWithTax:'1.18'}]}:{})},{documentId:randomUUID(),number:'1',issueDate:'2026-10-02T10:00:00Z'});
const greInput=()=>({companyId:1,origin:{branchId:randomUUID(),ubigeo:'150101',address:'Origen QA',establishmentCode:'0001'},destination:{branchId:randomUUID(),ubigeo:'150103',address:'Destino QA',establishmentCode:'0002'},reasonCode:'04',transferDate:'2026-10-02',grossWeight:'25.125',weightUnit:'KGM',nonRegulatedGoods:true,transport:{mode:'02',plate:'ABC123',driverDni:'99999999',driverFirstName:'PRUEBA',driverLastName:'FICTICIA',driverLicense:'Q99999999'},items:[{code:'Q1',description:'Ítem no regulado <&>',quantity:'2.5',unitCode:'NIU'}]});
let p12:Buffer,certificatePem:string;
beforeAll(()=>{const pair=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}),key=forge.pki.privateKeyFromPem(pair.privateKey),cert=forge.pki.createCertificate();cert.publicKey=forge.pki.publicKeyFromPem(pair.publicKey);cert.serialNumber='01';cert.validity.notBefore=new Date(Date.now()-3600000);cert.validity.notAfter=new Date(Date.now()+86400000);cert.setSubject([{name:'commonName',value:'QA NO SUNAT'}]);cert.setIssuer(cert.subject.attributes);cert.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true}]);cert.sign(key,forge.md.sha256.create());certificatePem=forge.pki.certificateToPem(cert);p12=Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key,cert,'FICTICIO',{algorithm:'aes256'})).getBytes(),'binary');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('Reglas fiscales y activación fail-closed',()=>{
  it('no homologa un snapshot aunque su perfil limitado sea correcto',()=>{const r=validateFiscalSnapshot(original,{mode:'LOCAL_DEVELOPMENT',now:new Date('2026-10-02T12:00:00Z')});expect(r.valid).toBe(true);expect(r.coverageComplete).toBe(false);expect(r.transmissionAuthorized).toBe(false);});
  it.each(['2026-02-30T12:00:00Z','2026-10-02T25:00:00Z','2026-10-02T12:00:00+14:30'])('rechaza calendario/reloj inválido %s',value=>expect(isFiscalTimestamp(value)).toBe(false));
  it('no confunde identificador ficticio con RUC real',()=>{expect(isRucStructurallyValid('00000000001')).toBe(false);expect(validateFiscalSnapshot(original,{mode:'REAL_PREPARATION'}).valid).toBe(false);});
  it('boletas mayores a 700 sin identidad y perfil tributario no admitido se bloquean',()=>{const b=receipt(1);Object.assign(b,calculateDocumentTotals([{description:'PRUEBA',quantity:'1',unitCode:'NIU',unitPriceWithTax:'700.01',taxAffectationCode:'10',igvRate:'18'}]));expect(validateFiscalSnapshot(b,{mode:'LOCAL_DEVELOPMENT'}).issues.some(i=>i.code==='BOLETA_ID_OVER_700')).toBe(true);b.lines[0].taxAffectationCode='20';expect(validateFiscalSnapshot(b,{mode:'LOCAL_DEVELOPMENT'}).valid).toBe(false);});
  it('no acepta certificado autofirmado como PKI confiable',async()=>{const r=await new CertificateTrustService().evaluate(inspectCertificate(p12,'FICTICIO'),'00000000001');expect(r.chainValid).toBe(false);expect(r.blockers).toContain('SELF_SIGNED_LEAF_NOT_ALLOWED');expect(r.revocation).toBe('PENDING');});
  it('no se activa producción por variables o un cliente HTTP',()=>{vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED','true');expect(()=>assertOfficialFiscalActivation()).toThrow('bloqueada');});
});
describe('Notas 07/08 con original y cálculo exacto',()=>{
  it.each([['01','07'],['01','08'],['03','07'],['03','08']] as const)('firma y verifica paquete propio %s/%s sin PFX real ni red', (originalType, type) => {
    const source = originalType === '01' ? original : receipt(1) as FiscalDocumentSnapshot;
    const n = buildNoteQaSnapshot(source, { idempotencyKey: randomUUID(), documentTypeCode: type,
      reasonCode: type === '07' ? '01' : '02', reasonDescription: 'Paquete ficticio de transporte',
      ...(type === '08' ? { lines: [{ originalLineNumber: 1, quantity: '1', unitPriceWithTax: '1.18' }] } : {}) },
      { documentId: randomUUID(), number: '1', issueDate: '2026-10-02T10:00:00Z' });
    const summary = originalType === '03' ? 'RC-20261002-1' : undefined;
    const prepared = prepareNotesQaXml(n, source, p12, 'FICTICIO', summary);
    const row = { snapshot: n, digestValue: prepared.digestValue, certificateFingerprint: prepared.certificateFingerprintSha256 };
    expect(() => verifyNotesTransportPackage(row as never, source, Buffer.from(prepared.xml), prepared.zip, `${prepared.fileName}.zip`, summary)).not.toThrow();
    expect(() => verifyNotesTransportPackage({ ...row, certificateFingerprint: '0'.repeat(64) } as never, source,
      Buffer.from(prepared.xml), prepared.zip, `${prepared.fileName}.zip`, summary)).toThrow('Certificado archivado');
  });
  it.each([['07','01'],['07','06'],['08','02']]as const)('genera UBL %s/%s y firma raíz real, no Invoice', (type,reason)=>{const n=note(type,reason),root=type==='07'?'CreditNote':'DebitNote',xml=buildNoteQaUbl(n,original);const signed=new XmlSignerService().sign(xml,p12,'FICTICIO',root);expect(verifyLocalSignedInvoice(signed.xml,certificatePem,xml,root)).toBe(signed.digestValue);expect(xml).toContain('<cac:BillingReference>');expect(xml).toContain('FQ01-1');expect(xml).toContain('Ajuste ficticio &amp; &lt;local&gt;');});
  it('parcial conserva precio original y bloquea sobredevolución/motivo desconocido',()=>{const input={idempotencyKey:randomUUID(),documentTypeCode:'07',reasonCode:'07',reasonDescription:'Devolución QA',lines:[{originalLineNumber:1,quantity:'1'}]},id={documentId:randomUUID(),number:'2',issueDate:'2026-10-02T12:00:00Z'};expect(buildNoteQaSnapshot(original,input,id).totals.payableAmount).toBe('11.80');expect(()=>buildNoteQaSnapshot(original,{...input,lines:[{originalLineNumber:1,quantity:'3'}]},id)).toThrow();expect(()=>buildNoteQaSnapshot(original,{...input,reasonCode:'99'},id)).toThrow();});
  it('rechaza cambiar referencia, cliente y totales archivados',()=>{for(const field of ['totals','customer','reference']as const){const n=note('07','01');if(field==='totals')n.totals.payableAmount='0.01';else if(field==='customer')n.customer.legalName='OTRO';else n.reference.fullNumber='FQ01-999';expect(()=>validateNoteQaSnapshot(n,original)).toThrow();}});
});
describe('Lotes múltiples RC/RA',()=>{
  it.each(['RC_ALTA','RC_BAJA']as const)('%s conserva todas las boletas con condición exacta',kind=>{const input={kind,snapshots:[receipt(1),receipt(2)]},xml=buildBatchQaXml(input,'RC-20261002-1');expect(xml.match(/<sac:SummaryDocumentsLine>/g)).toHaveLength(2);expect(xml.match(new RegExp(`<cbc:ConditionCode>${kind==='RC_ALTA'?'1':'3'}`,'g'))).toHaveLength(2);const signed=new XmlSignerService().sign(xml,p12,'FICTICIO','SummaryDocuments');expect(verifyLocalSignedInvoice(signed.xml,certificatePem,xml,'SummaryDocuments')).toBe(signed.digestValue);});
  it('RA usa raíz VoidedDocuments y motivo, no modifica ni resta ventas',()=>{const xml=buildBatchQaXml({kind:'RA',snapshots:[original],reasons:['Error & prueba'],notDelivered:true},'RA-20261002-1');expect(xml).toContain('<sac:VoidReasonDescription>Error &amp; prueba');expect(xml).not.toContain('PayableAmount');const signed=new XmlSignerService().sign(xml,p12,'FICTICIO','VoidedDocuments');expect(verifyLocalSignedInvoice(signed.xml,certificatePem,xml,'VoidedDocuments')).toBe(signed.digestValue);});
  it('admite puntos diferentes del mismo RUC y fecha',()=>{const a=receipt(1),b=receipt(2);b.issuer.establishmentCode='0002';expect(()=>validateBatchQa({kind:'RC_ALTA',snapshots:[a,b]})).not.toThrow();});
  it('no mezcla RUC, fechas, duplicados ni facturas en RC',()=>{for(const mutate of [(s:FiscalDocumentSnapshot)=>s.issuer.identityNumber='00000000002',(s:FiscalDocumentSnapshot)=>s.issueDate='2026-09-30T16:00:00Z',(s:FiscalDocumentSnapshot)=>{s.documentTypeCode='01';s.series='FQ01';s.fullNumber='FQ01-2';}]){const a=receipt(1),b=receipt(2);mutate(b);expect(()=>validateBatchQa({kind:'RC_ALTA',snapshots:[a,b]})).toThrow();}const a=receipt(1);expect(()=>validateBatchQa({kind:'RC_ALTA',snapshots:[a,a]})).toThrow();});
  it('no admite baja sin declaración ni motivos, XML path o más de 50 miembros',()=>{expect(()=>buildBatchQaXml({kind:'RA',snapshots:[original]},'RA-20261002-1')).toThrow();expect(()=>buildBatchQaXml({kind:'RC_ALTA',snapshots:[receipt(1)]},'../../evil')).toThrow();expect(()=>validateBatchQa({kind:'RC_ALTA',snapshots:Array.from({length:51},(_,i)=>receipt(i+1))})).toThrow();});
  it('canonicaliza selección y no permite campos o UUID duplicados por mayúscula',()=>{const a=randomUUID(),b=randomUUID();expect(parseBatchQaRequest({kind:'RC_ALTA',scenario:'ACCEPTED',documentIds:[b,a]}).documentIds).toEqual([a,b].sort());expect(()=>parseBatchQaRequest({kind:'RC_ALTA',scenario:'ACCEPTED',documentIds:[a,a.toUpperCase()]})).toThrow();expect(()=>parseBatchQaRequest({kind:'RC_ALTA',scenario:'ACCEPTED',documentIds:[a],ruc:'20450819230'})).toThrow();});
});
describe('GRE local no habilita combustibles ni traslado oficial',()=>{
  it('construye y firma DespatchAdvice con origen/destino/conductor/mercancía',()=>{const input=validateGreQaInput(greInput(),'2026-10-02'),id=randomUUID(),xml=buildGreQaUbl({...input,id,localIdentifier:`GRE-QA-${id}`,ublNumber:'TQ00-1',issueDate:'2026-10-02',issueTime:'12:00:00',issuer:{ruc:'00000000001',legalName:'EMISOR QA'},environment:'BETA',profile:GRE_QA_PROFILE});expect(xml).toContain('NO AUTORIZA TRASLADO');const signed=new XmlSignerService().sign(xml,p12,'FICTICIO','DespatchAdvice');expect(verifyLocalSignedInvoice(signed.xml,certificatePem,xml,'DespatchAdvice')).toBe(signed.digestValue);});
  it.each([(v:ReturnType<typeof greInput>)=>v.nonRegulatedGoods=false,(v:ReturnType<typeof greInput>)=>v.transport.plate='ABC-123',(v:ReturnType<typeof greInput>)=>v.transferDate='2026-02-30',(v:ReturnType<typeof greInput>)=>v.destination.branchId=v.origin.branchId])('rechaza entrada no cubierta/incompleta (%#)',mutate=>{const v=greInput();mutate(v);expect(()=>validateGreQaInput(v,'2026-10-02')).toThrow();});
});
describe('Regresión: certificados, listado y transporte deshabilitado',()=>{
  it('no descarga una nota firmada con revisión anterior',async()=>{
    const n=note('07','01'),read=vi.fn(),row={id:n.documentId,originalDocumentId:original.documentId,state:'SIGNED_LOCAL',snapshot:n,digestValue:'a'.repeat(43)+'=',xmlArtifact:{},zipArtifact:{},originalSha256:createHash('sha256').update(noteQaCanonical(original)).digest('hex'),credentialRevision:1,certificateFingerprint:'OLD'};
    const service=new NotesQaService({}as never,{}as never,{find:async()=>row}as never,{}as never,{read}as never,{}as never,{}as never);
    Object.assign(service,{enabled:()=>{},actor:async()=>({}),context:async()=>({snapshot:original,credentials:{revision:2,certificateFingerprint:'NEW'}})});
    await expect(service.download(n.documentId,'xml','Bearer LOCAL')).rejects.toThrow('Certificado cambió');expect(read).not.toHaveBeenCalled();
  });
  it('un lote histórico bloqueado no impide consultar otros, pero una sesión inválida sí',async()=>{
    const snapshots=[receipt(1),receipt(2)],rows=snapshots.map(s=>({id:randomUUID(),immutablePayload:{kind:'RC_ALTA',snapshots:[s]},credentialRevision:1}));
    const local={context:vi.fn(async(id:string)=>{if(id===snapshots[0].documentId)throw new ConflictException('Certificado vencido');return{snapshot:snapshots[1],credentials:{revision:1}};})};
    const service=new FiscalBatchQaService({fiscalBatchQa:{findMany:async()=>rows}}as never,local as never,{}as never,{}as never,{}as never,{}as never);Object.assign(service,{enabled:()=>{}});
    const result=await service.list('Bearer LOCAL');expect(result.items).toHaveLength(1);expect(result.unavailableCount).toBe(1);
    local.context.mockRejectedValue(new UnauthorizedException('Sesión revocada'));await expect(service.list('Bearer LOCAL')).rejects.toThrow('Sesión revocada');
  });
  it('no activa GRE QA junto con transmisión Beta externa',async()=>{
    vi.stubEnv('GRE_QA_ENABLED','true');vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED','true');const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const service=new GreQaService({}as never,{}as never,{}as never,{}as never,{}as never);await expect(service.capabilities()).rejects.toThrow('transmisión externa deshabilitada');expect(fetcher).not.toHaveBeenCalled();
  });
  it('adaptador REST preparado no solicita tokens si el envío está deshabilitado',async()=>{
    vi.stubEnv('GRE_EXTERNAL_TRANSMISSION_ENABLED','false');const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const adapter=new SunatGreRestAdapter({environment:'PRODUCTION',enabled:true,ruc:'20450819230',solUser:'FICTICIO',solPassword:'NO_USAR',clientId:randomUUID(),clientSecret:'NO_USAR',credentialRevision:1,readiness:{certificateTrusted:false,xsdValidated:false,fiscalRulesValidated:false}});
    await expect(adapter.getStatus(randomUUID())).rejects.toThrow('TRANSMISION_DESHABILITADA');expect(fetcher).not.toHaveBeenCalled();
  });
});
