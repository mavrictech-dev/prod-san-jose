import {describe,it,expect} from 'vitest';
import {reconcileSyntheticEvidence,reconciliationIssuesCsv} from '../packages/evidence-core/src/reconciliation';
import {createBusinessEvidenceSnapshot,buildBusinessEvidenceXml} from '../packages/evidence-core/src/fixtures';
const entry=(type:'01'|'03'|'07'|'08'='01',n=1)=>{const snapshot=createBusinessEvidenceSnapshot(type,n);return {snapshot,xml:buildBusinessEvidenceXml(snapshot)};};
const input=()=>({schemaVersion:'factuez.evidence-reconciliation-input.v1',environment:'BETA',datasetClass:'SYNTHETIC',runId:'00000000-0000-4000-8000-000000099999',legacy:[entry()],factuez:[entry()]});
describe('conciliación sin emisión, outbox, aprobación ni cambio de series',()=>{
  it('compara selecciones y binding completo sin mutar ni aprobar',()=>{
    const data=input(),before=JSON.stringify(data),r=reconcileSyntheticEvidence(data);
    expect(JSON.stringify(data)).toBe(before);expect(r).toMatchObject({issueCount:0,documentsMatched:1,xmlBindingsMatched:2,accountingApproved:false,cutoverAuthorized:false,fiscalWrites:0,outboxWrites:0});
    expect(r.status).toBe('MATCH_REQUIRES_ACCOUNTING_REVIEW');
  });
  it('detecta cambio de cliente aunque coincidan importes y números',()=>{
    const d=input(),s=structuredClone(d.factuez[0].snapshot);s.customer.legalName='OTRO FICTICIO';d.factuez[0]={snapshot:s,xml:buildBusinessEvidenceXml(s)};
    const r=reconcileSyntheticEvidence(d);expect(r.totals.match).toBe(true);expect(r.issueCount).toBe(1);expect(r.issues[0].path).toBe('business.customer.legalName');
  });
  it('un XML de otro cliente se identifica por lado, sin ocultar el origen',()=>{
    const d=input();d.factuez[0].xml=d.factuez[0].xml.replace('CLIENTE FICTICIO QA','OTRO FICTICIO');
    expect(reconcileSyntheticEvidence(d).issues).toEqual(expect.arrayContaining([expect.objectContaining({side:'FACTUEZ',code:'XML_BINDING_DIFFERENCE'})]));
  });
  it('documento faltante nunca es coincidencia',()=>{
    const d=input();d.factuez=[];const r=reconcileSyntheticEvidence(d);expect(r.totals.match).toBe(false);expect(r.issues[0].code).toBe('DOCUMENT_MISSING');
  });
  it('faltan XML en ambos lados: informa dos ausencias',()=>{
    const d:any=input();d.legacy[0].xml=null;d.factuez[0].xml=null;const r=reconcileSyntheticEvidence(d);expect(r.xmlMissing).toBe(2);expect(r.issueCount).toBe(2);
  });
  it('XML no permitido produce código sanitizado sin filtrar texto o ruta',()=>{
    const d=input();d.factuez[0].xml='<!DOCTYPE Invoice SECRET>';const r=reconcileSyntheticEvidence(d);expect(r.xmlInvalid).toBe(1);expect(JSON.stringify(r.issues)).not.toContain('SECRET');
  });
  it('notas positivas se separan por tipo; no calcula ventas netas',()=>{
    const d=input();d.legacy=[entry('01'),entry('07'),entry('08'),entry('03')];d.factuez=structuredClone(d.legacy);const r=reconcileSyntheticEvidence(d);
    expect(r.legacySummary.groups).toHaveLength(4);expect(r.legacySummary.groups.every(g=>g.amounts.payableAmount==='118.00')).toBe(true);expect(r).not.toHaveProperty('netSales');
  });
  it('hash e IDs son deterministas y cambian ante diferencias nuevas',()=>{
    const d=input();d.factuez[0].xml=d.factuez[0].xml.replace('FUEL-QA','OTRO-QA');const r=reconcileSyntheticEvidence(d);
    expect(reconcileSyntheticEvidence(d)).toEqual(r);d.factuez[0].xml=d.factuez[0].xml.replace('OTRO-QA','TERCERO-QA');expect(reconcileSyntheticEvidence(d).issues[0].id).not.toBe(r.issues[0].id);
  });
  it('duplicados fiscales/origen no se pisan silenciosamente en un Map',()=>{
    const d=input();d.legacy.push(d.legacy[0]);expect(()=>reconcileSyntheticEvidence(d)).toThrow(/DUPLICATE_IDENTITY/);
  });
  it.each(['environment','datasetClass','schemaVersion'])('bloquea perfil ajeno por %s',field=>{
    const d:any=input();d[field]='PRODUCTION';expect(()=>reconcileSyntheticEvidence(d)).toThrow(/PROFILE_BLOCKED/);
  });
  it('CSV protege texto con fórmulas y conserva diferencias para revisión',()=>{
    const d=input(),s=structuredClone(d.factuez[0].snapshot);s.customer.legalName='=HYPERLINK("malicioso")';d.factuez[0]={snapshot:s,xml:buildBusinessEvidenceXml(s)};
    const csv=reconciliationIssuesCsv(reconcileSyntheticEvidence(d));expect(csv).toContain("\"'=HYPERLINK");expect(csv).toContain('BUSINESS_DIFFERENCE');
  });
  it('snapshot de cliente real nunca entra por haber etiquetado BETA',()=>{
    const d:any=structuredClone(input());d.factuez[0].snapshot.issuer.ruc='20615878481';expect(()=>reconcileSyntheticEvidence(d)).toThrow();
  });
  it('entradas con getters nunca se ejecutan',()=>{
    let calls=0;const d:any=input();Object.defineProperty(d,'factuez',{enumerable:true,get(){calls++;return [];}});expect(()=>reconcileSyntheticEvidence(d)).toThrow();expect(calls).toBe(0);
  });
  it('conciliación admite XML completos de 100 líneas y más de 16 KB sin cambiar guards del historial',()=>{
    const d=input(),s:any=structuredClone(d.legacy[0].snapshot);s.items=Array.from({length:100},(_,i)=>({...s.items[0],lineNumber:i+1}));
    s.amounts.taxableAmount='10000.00';s.amounts.igvAmount='1800.00';s.amounts.payableAmount='11800.00';s.tax[0].taxableAmount='10000.00';s.tax[0].taxAmount='1800.00';
    const text=buildBusinessEvidenceXml(s);expect(text.length).toBeGreaterThan(16000);d.legacy=[{snapshot:s,xml:text}];d.factuez=structuredClone(d.legacy);
    const r=reconcileSyntheticEvidence(d);expect(r.issueCount).toBe(0);expect(r.xmlBindingsMatched).toBe(2);
  });
  it('array con getter no ejecuta acceso a elementos',()=>{
    const d=input();let calls=0;Object.defineProperty(d.legacy,'0',{enumerable:true,get(){calls++;return entry();}});
    expect(()=>reconcileSyntheticEvidence(d)).toThrow();expect(calls).toBe(0);
  });
});
