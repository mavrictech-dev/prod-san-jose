import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {compareShadowCase,compareShadowRun,assertShadowOperation,SHADOW_LIMITS} from '../packages/shadow-core/src';
const fixture=createRequire(import.meta.url)('../migration/fixtures/shadow-development.cjs');
const f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
const policy={environment:'BETA',datasetClass:'SYNTHETIC',mode:'SHADOW',transmission:false,persisted:false,
  fiscalWrites:0,outboxWrites:0,countersChanged:false,fiscalAuthority:false,cutoverAuthorized:false,signatureVerified:false,cdrAuthenticityVerified:false,pdfBytesVerified:false,
  accountingApproved:false,productionBlocked:true,reviewRequired:true};
describe('fase 4: comparación sintética sin efectos',()=>{
  it('equivalencia comparativa conserva los bloqueos y las revisiones pendientes',()=>{
    const c=fixture.pair(),before=JSON.stringify(c),r=compareShadowCase(c);
    expect(r).toMatchObject({...policy,comparativeMatch:true,status:'MATCH_WITH_UNVERIFIED_EVIDENCE',differenceCount:0});
    expect(r.xml.legacy!.rawSha256).not.toBe(r.xml.factuez!.rawSha256);
    expect(r.xml.legacy!.structuralSha256).toBe(r.xml.factuez!.structuralSha256);
    expect(r.printEvidence).toBe('DECLARED_PROJECTIONS_ONLY');expect(JSON.stringify(c)).toBe(before);
    expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.xml.legacy)).toBe(true);
  });
  it.each(['01','03','07','08'])('compara el contrato completo del tipo %s',type=>{
    expect(compareShadowCase(fixture.pair(1,type)).comparativeMatch).toBe(true);
  });
  it('lote mixto distingue igualdad, diferencias fiscales, ausencia y cosmética',()=>{
    const r=compareShadowRun(fixture.run());expect(r).toMatchObject({...policy,count:4,matchingCount:1,comparativeMatch:false});
    expect(r.reports.map(c=>c.status)).toEqual(['MATCH_WITH_UNVERIFIED_EVIDENCE','DIFFERENCES_FOUND','INCOMPLETE','DIFFERENCES_FOUND']);
    expect(r.reports[1].counts.CORRECTION_REQUIRED).toBeGreaterThan(0);expect(r.reports[3].counts).toEqual({CORRECTION_REQUIRED:0,COSMETIC:1,DATA_MISSING:0});
  });
  it.each(['environment','datasetClass','mode','schemaVersion'])('bloquea perfil ajeno en %s',field=>{
    const c=fixture.pair();c[field]='PRODUCTION';expect(()=>compareShadowCase(c)).toThrow(/SHADOW_PROFILE_BLOCKED/);
  });
  it.each(['environment','datasetClass','mode','schemaVersion'])('bloquea perfil ajeno del lote en %s',field=>{
    const r=fixture.run();r[field]='PRODUCTION';expect(()=>compareShadowRun(r)).toThrow(/SHADOW_PROFILE_BLOCKED/);
  });
  it('rechaza RUC real aunque conserve etiquetas sintéticas',()=>{
    const c=fixture.pair();c.legacy.snapshot.ownership.issuerRuc='20615878481';c.legacy.snapshot.issuer.ruc='20615878481';
    expect(()=>compareShadowCase(c)).toThrow(/INVALID_TEXT/);
  });
  it.each(['originId','sourceDocumentId'])('no compara orígenes distintos: %s',field=>{
    const c=fixture.pair();c.factuez.snapshot[field]=field==='originId'?'OTRO-ORIGEN':f.uuid(999);
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_PAIR_ORIGIN_MISMATCH/);
  });
  it('decimales se normalizan sin perder centavos ni hacer redondeos tolerantes',()=>{
    const c=fixture.pair();c.factuez.snapshot.items[0].quantity='2.000000';c.factuez.snapshot.amounts.payableAmount='118';
    expect(compareShadowCase(c).comparativeMatch).toBe(true);
  });
  it('cambio de unidad, afectación y precio se identifica por campo',()=>{
    const c=fixture.pair();Object.assign(c.factuez.snapshot.items[0],{unitCode:'LTR',taxAffectationCode:'20',unitValue:'51'});
    const r=compareShadowCase(c);expect(r.differences.map(d=>d.path)).toEqual(expect.arrayContaining(['snapshot.items.0.unitCode','snapshot.items.0.taxAffectationCode','snapshot.items.0.unitValue']));
  });
  it('importes por encima de Number seguro conservan el centavo diferente',()=>{
    const c=fixture.pair();
    for(const label of ['legacy','factuez']){const s=c[label].snapshot;s.amounts.taxableAmount=label==='legacy'?'9999999999999999.99':'9999999999999999.98';
      s.amounts.igvAmount='0.00';s.amounts.payableAmount=s.amounts.taxableAmount;s.items[0].amounts={...s.amounts};s.tax[0].taxableAmount=s.amounts.taxableAmount;s.tax[0].taxAmount='0.00';
      c[label]=fixture.side(s,label);}
    const r=compareShadowCase(c),d=r.differences.find(d=>d.path==='snapshot.amounts.payableAmount');
    expect(d?.legacy).toContain('9999999999999999.99');expect(d?.factuez).toContain('9999999999999999.98');
  });
  it('no oculta número ni fecha fiscal del XML como campos variables',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('FQ01-1','FQ01-2').replace('2026-10-01','2026-10-02');
    const r=compareShadowCase(c);expect(r.counts.CORRECTION_REQUIRED).toBe(3);
    expect(r.differences.map(d=>d.path)).toContain('xml.factuez.snapshotBinding.fullNumber');
  });
  it('la misma cabecera XML errónea en ambos lados no produce match',()=>{
    const c=fixture.pair();for(const label of ['legacy','factuez'])c[label].xml=c[label].xml.replace('FQ01-1','FQ01-999');
    expect(compareShadowCase(c).counts.CORRECTION_REQUIRED).toBe(2);
  });
  it('no excluye texto de negocio con apariencia de timestamp',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('</Invoice>','<b:IssueTime>10:00:00</b:IssueTime></Invoice>');
    expect(compareShadowCase(c).comparativeMatch).toBe(false);
  });
  it('fecha QR se contrasta en Lima, no en la zona local del equipo',()=>{
    const c=fixture.pair();for(const label of ['legacy','factuez']){c[label].snapshot.issueDate='2026-10-02T01:00:00Z';c[label]=fixture.side(c[label].snapshot,label);}
    expect(compareShadowCase(c).comparativeMatch).toBe(true);expect(c.factuez.prints[0].qrFields.issueDate).toBe('2026-10-01');
  });
  it('representaciones horarias del mismo instante no crean diferencia de snapshot',()=>{
    const c=fixture.pair();c.factuez.snapshot.issueDate='2026-10-01T15:00:00Z';expect(compareShadowCase(c).comparativeMatch).toBe(true);
  });
  it('QR incorrecto idéntico en ambas proyecciones no se acepta',()=>{
    const c=fixture.pair();for(const label of ['legacy','factuez'])for(const p of c[label].prints)p.qrFields.payableAmount='0.00';
    expect(compareShadowCase(c).counts.CORRECTION_REQUIRED).toBe(4);
  });
  it('el hash declarado de impresión debe coincidir con su propio XML, no con el otro emisor',()=>{
    const c=fixture.pair();c.factuez.prints[0].digestValue=fixture.digest('OTHER');
    expect(compareShadowCase(c).differences.map(d=>d.path)).toContain('prints.factuez.TICKET_80MM.digestBinding');
  });
  it('no confunde hash declarado sin firma con evidencia verificable',()=>{
    const c=fixture.pair();c.factuez.xml=fixture.xml(c.factuez.snapshot);
    const r=compareShadowCase(c);expect(r.counts.DATA_MISSING).toBe(2);expect(r.signatureVerified).toBe(false);
  });
  it('diferencia de páginas/dimensiones de impresión requiere corrección',()=>{
    const c=fixture.pair();c.factuez.prints[0].pageSizesMicrometers[0].width=58000;
    expect(compareShadowCase(c).differences).toContainEqual(expect.objectContaining({path:'prints.TICKET_80MM.pageSizesMicrometers.0.width',category:'CORRECTION_REQUIRED'}));
  });
  it('no oculta diferencia de contenido impreso',()=>{
    const c=fixture.pair();c.factuez.prints[1].textLines[3]='Total 1.00';
    expect(compareShadowCase(c).comparativeMatch).toBe(false);
  });
  it('el importe en letras no se rebaja automáticamente a diferencia cosmética',()=>{
    const c=fixture.pair();c.legacy.snapshot.amountInWords='CIENTO DIECIOCHO SOLES';c.factuez.snapshot.amountInWords='MIL SOLES';
    expect(compareShadowCase(c).differences).toContainEqual(expect.objectContaining({path:'snapshot.amountInWords',category:'CORRECTION_REQUIRED'}));
  });
  it('cambio de metadata PDF no prueba cambio del contenido ni bytes verificados',()=>{
    const c=fixture.pair(),a=compareShadowCase(c);c.factuez.prints[0].pdfSha256='a'.repeat(64);const b=compareShadowCase(c);
    expect(b.comparativeMatch).toBe(true);expect(b.inputSha256).not.toBe(a.inputSha256);expect(b.pdfBytesVerified).toBe(false);
  });
  it('evidencia aceptada declarada no se convierte en aceptación ni cierre',()=>{
    const c=fixture.pair();c.factuez.snapshot.sourceEvidence.declaredStatus='DECLARED_ACCEPTED';
    expect(compareShadowCase(c)).toMatchObject({...policy,comparativeMatch:true});
  });
  it('XML/formatos ausentes en ambos lados siguen siendo incompletos',()=>{
    const c=fixture.pair();for(const label of ['legacy','factuez']){c[label].xml=null;c[label].prints=[];}
    expect(compareShadowCase(c)).toMatchObject({status:'INCOMPLETE',differenceCount:3,comparativeMatch:false});
  });
  it('proyección con un formato duplicado se rechaza',()=>{
    const c=fixture.pair();c.factuez.prints=[c.factuez.prints[0],c.factuez.prints[0]];
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_PRINT_DUPLICATE/);
  });
  it('proyección sin procedencia sintética declarada se rechaza',()=>{
    const c=fixture.pair();c.factuez.prints[0].provenance='PARSED_REAL_PDF';expect(()=>compareShadowCase(c)).toThrow(/SHADOW_PRINT_PROFILE_BLOCKED/);
  });
  it('contenido impreso vacío no se trata como proyección íntegra',()=>{
    const c=fixture.pair();c.factuez.prints[0].textLines=[];expect(()=>compareShadowCase(c)).toThrow(/SHADOW_PRINT_INVALID/);
  });
  it('no ejecuta getters ni proxies, ni admite un callback de emisión',()=>{
    const getter=vi.fn(),c=fixture.pair();Object.defineProperty(c,'legacy',{enumerable:true,get:getter});
    expect(()=>compareShadowCase(c)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(()=>compareShadowCase(new Proxy(fixture.pair(),{}))).toThrow();
    const other=fixture.pair();other.send=vi.fn();expect(()=>compareShadowCase(other)).toThrow();expect(other.send).not.toHaveBeenCalled();
  });
  it('acota ejemplos de diferencias conservando el conteo completo',()=>{
    const c=fixture.pair();for(const label of ['legacy','factuez'])c[label].snapshot.items=Array.from({length:100},(_,i)=>({...c[label].snapshot.items[0],lineNumber:i+1,
      description:label==='legacy'?'LEGACY':'FACTUEZ',unitCode:label==='legacy'?'GLL':'LTR',quantity:label==='legacy'?'2':'3'}));
    for(const label of ['legacy','factuez']){const s=c[label].snapshot;s.amounts.taxableAmount='10000.00';s.amounts.igvAmount='1800.00';s.amounts.payableAmount='11800.00';
      s.tax[0].taxableAmount='10000.00';s.tax[0].taxAmount='1800.00';c[label]=fixture.side(s,label);}
    const r=compareShadowCase(c);expect(r.differenceCount).toBe(300);expect(r.differences).toHaveLength(SHADOW_LIMITS.differences);expect(r.differencesTruncated).toBe(true);
  });
  it('reordenar el lote conserva el orden determinista de reportes',()=>{
    const r=fixture.run(),a=compareShadowRun(r);r.cases.reverse();expect(compareShadowRun(r).reports).toEqual(a.reports);
  });
  it('duplicados por ID de caso y por origen no se ocultan',()=>{
    const r=fixture.run();r.cases.push(r.cases[0]);expect(()=>compareShadowRun(r)).toThrow(/SHADOW_RUN_DUPLICATE/);
    const other=fixture.run(),copy=structuredClone(other.cases[0]);copy.caseId=f.uuid(222);other.cases.push(copy);
    expect(()=>compareShadowRun(other)).toThrow(/SHADOW_RUN_DUPLICATE/);
  });
  it.each([0,51])('limita cantidad de casos: %s',count=>{
    const r=fixture.run();r.cases=Array.from({length:count},(_,i)=>fixture.pair(i+1));expect(()=>compareShadowRun(r)).toThrow(/SHADOW_RUN_LIMIT/);
  });
  it('identidad fiscal repetida con otro origen no se disimula en otro caso',()=>{
    const r=fixture.run(),other=fixture.pair(99);other.legacy.snapshot.number='1';
    r.cases.push(other);expect(()=>compareShadowRun(r)).toThrow(/SHADOW_RUN_DUPLICATE_FISCAL/);
  });
  it.each(['SEND_SOAP','SEND_REST','RESERVE_NUMBER','WRITE_OUTBOX','IMPORT_HISTORY','SIGN_REAL_KEY','ENABLE_PRODUCTION',null,{}])('ninguna operación puede activar efectos: %s',operation=>{
    expect(()=>assertShadowOperation(operation)).toThrow(/SHADOW_OPERATION_BLOCKED/);
  });
  it('la dependencia de shadow-core no incluye transporte, BD, certificados o colas',()=>{
    const p=JSON.parse(readFileSync(new URL('../packages/shadow-core/package.json',import.meta.url),'utf8'));
    expect(Object.keys(p.dependencies).sort()).toEqual(['@factuez/history-core','@xmldom/xmldom']);
    for(const file of ['index.ts','xml.ts'])expect(readFileSync(new URL('../packages/shadow-core/src/'+file,import.meta.url),'utf8')).not.toMatch(/(?:from\s+['"](?:node:)?(?:fs|http|https|net|tls|child_process)|\bfetch\s*\(|process\.env|\.listen\s*\()/);
  });
});
describe('fase 4: XML estructural estricto, no canónico ni fiscalmente validado',()=>{
  it.each(['\u0000','\u0008','\ud800','\udfff'])('rechaza caracteres XML ilegales: %j',character=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('FQ01-1','FQ01-1'+character);
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_XML_INVALID/);
  });
  it('compara texto Unicode y entidades predefinidas sin leer entidades externas',()=>{
    const c=fixture.pair();for(const label of ['legacy','factuez'])c[label].xml=c[label].xml.replace('XML FICTICIO','DIÉSEL &amp; GASOLINA');
    expect(compareShadowCase(c).comparativeMatch).toBe(true);
  });
  it.each(['<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///secret">]><Invoice/>','<!-- COMMENT -->','<![CDATA[bad]]>','<?custom run?>','<Invoice>','<Invoice/><Invoice/>'])('rechaza payload no permitido %s',xml=>{
    const c=fixture.pair();c.factuez.xml=xml;expect(()=>compareShadowCase(c)).toThrow(/SHADOW_XML_/);
  });
  it('cambio de namespace es significativo, no sólo el nombre local',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('xmlns:b="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"','xmlns:b="urn:EVIL"');
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_XML_HEADER_INVALID/);
  });
  it('firma en ubicación alternativa no se excluye silenciosamente',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('<ext:ExtensionContent>','<ext:OTHER>').replace('</ext:ExtensionContent>','</ext:OTHER>');
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_XML_SIGNATURE_LOCATION/);
  });
  it('cabecera duplicada y firma duplicada son ambiguas y se rechazan',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('</Invoice>','<b:ID>FQ01-1</b:ID></Invoice>');
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_XML_HEADER_INVALID/);
    const other=fixture.pair();other.factuez.xml=other.factuez.xml.replace('</ext:ExtensionContent>','<ds:Signature/></ext:ExtensionContent>');
    expect(()=>compareShadowCase(other)).toThrow(/SHADOW_XML_SIGNATURE_AMBIGUOUS/);
  });
  it('no oculta ID de negocio fuera de la firma',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('<b:ID>','<b:ID Id="BUSINESS-ID">');
    expect(compareShadowCase(c).differences.map(d=>d.path)).toContain('xml.structuralSha256');
  });
  it('ID repetido incluso dentro de la firma se rechaza',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('<b:ID>','<b:ID Id="SYNTHETIC-factuez">');
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_XML_DUPLICATE_ID/);
  });
  it('limita profundidad y longitud XML',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replace('</Invoice>','<b:X>'.repeat(34)+'</b:X>'.repeat(34)+'</Invoice>');
    expect(()=>compareShadowCase(c)).toThrow(/SHADOW_XML_LIMIT/);
    const other=fixture.pair();other.factuez.xml='x'.repeat(16001);expect(()=>compareShadowCase(other)).toThrow(/JSON_LIMIT/);
  });
  it('espaciado entre elementos no oculta texto dentro de un elemento fiscal',()=>{
    const c=fixture.pair();c.factuez.xml=c.factuez.xml.replaceAll('><','>\n  <');expect(compareShadowCase(c).comparativeMatch).toBe(true);
    c.factuez.xml=c.factuez.xml.replace('FQ01-1',' FQ01-1 ');expect(compareShadowCase(c).comparativeMatch).toBe(false);
  });
});
