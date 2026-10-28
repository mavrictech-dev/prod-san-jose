import {describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {summarizeHistoricalSelection,compareHistoricalTotals} from '../packages/history-core/src';
const f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');
const expected=(groups:unknown[])=>({schemaVersion:'factuez.history-expected-totals.v1',environment:'BETA',datasetClass:'SYNTHETIC',groups});
describe('historial: conciliación exacta de una selección, sin aprobación',()=>{
  it('suma ítems completos en centavos, no pierde snapshot ni lo muta',()=>{
    const source=f.exported(101).documents,before=JSON.stringify(source),r=summarizeHistoricalSelection(source);
    expect(JSON.stringify(source)).toBe(before);expect(r.count).toBe(101);
    expect(r.groups[0].amounts).toMatchObject({taxableAmount:'10100.00',igvAmount:'1818.00',payableAmount:'11918.00'});
    expect(r).toMatchObject({environment:'BETA',datasetClass:'SYNTHETIC',fiscalAuthority:false,accountingApproved:false,reviewRequired:true,countersChanged:false});
  });
  it('no agrega PEN y USD ni distintos RUC en un gran total',()=>{
    const a=f.document(1),b=f.document(2),c=f.document(1,2,'01');b.currencyCode='USD';
    const r=summarizeHistoricalSelection([a,b,c]);expect(r.groups).toHaveLength(3);
    expect(r.groups.every(g=>g.amounts.payableAmount==='118.00')).toBe(true);expect(r).not.toHaveProperty('totalPayable');
  });
  it('importes mayores al entero seguro conservan hasta el último centavo',()=>{
    const docs=[f.document(1),f.document(2)];
    for(const d of docs){d.amounts.taxableAmount='9999999999999999.99';d.amounts.igvAmount='0.00';d.amounts.payableAmount=d.amounts.taxableAmount;
      d.items[0].amounts={...d.amounts};d.items[0].igvRate='0';d.tax[0].taxableAmount=d.amounts.taxableAmount;d.tax[0].taxAmount='0.00';}
    expect(summarizeHistoricalSelection(docs).groups[0].amounts.payableAmount).toBe('19999999999999999.98');
  });
  it('no inventa huecos al separar las monedas de la misma serie',()=>{
    const a=f.document(1),b=f.document(2),c=f.document(3);b.currencyCode='USD';
    const r=summarizeHistoricalSelection([a,b,c]);expect(r.groups).toHaveLength(2);expect(r.seriesSequences).toHaveLength(1);
    expect(r.seriesSequences[0]).toMatchObject({minNumber:'1',maxNumber:'3',missingCount:0,ranges:[]});
  });
  it('hueco hasta 99 millones se representa en rango, no en millones de objetos',()=>{
    const r=summarizeHistoricalSelection([f.document(1),f.document(99999999)]);
    expect(r.seriesSequences[0]).toMatchObject({missingCount:99999997,rangeCount:1,ranges:[{from:'2',to:'99999998'}]});
  });
  it('acota ejemplos de huecos, conserva conteos completos',()=>{
    const r=summarizeHistoricalSelection(Array.from({length:25},(_,i)=>f.document(2*i+1)));
    expect(r.seriesSequences[0]).toMatchObject({missingCount:24,rangeCount:24,rangesTruncated:true});expect(r.seriesSequences[0].ranges).toHaveLength(20);
  });
  it('los estados y artefactos declarados no se vuelven aceptación fiscal',()=>{
    const a=f.exported(1,true).documents[0];a.sourceEvidence.declaredStatus='DECLARED_ACCEPTED';
    const r=summarizeHistoricalSelection([a]);expect(r.declaredStates.DECLARED_ACCEPTED).toBe(1);
    expect(r.evidence).toMatchObject({missingCdr:0,missingSignedXml:0,declaredOnly:true});expect(r.cdrAuthenticityVerified).toBe(false);
  });
  it('nota positiva y referencia fuera del periodo no se convierten en ventas netas o error fiscal',()=>{
    const note=f.document(2,1,'07'),r=summarizeHistoricalSelection([note]);
    expect(r.groups[0].amounts.payableAmount).toBe('118.00');expect(r.referencesOutsideSelection).toBe(1);
    expect(r.diagnostics[0].code).toBe('REFERENCE_NOT_IN_SELECTION');
    expect(summarizeHistoricalSelection([f.document(1,1,'01'),note]).referencesOutsideSelection).toBe(0);
  });
  it('acota referencias de revisión sin perder el conteo',()=>{
    const docs=Array.from({length:101},(_,i)=>f.document(i+1,1,'07')),r=summarizeHistoricalSelection(docs);
    expect(r.referencesOutsideSelection).toBe(101);expect(r.diagnostics).toHaveLength(100);expect(r.diagnosticsTruncated).toBe(true);
  });
  it('selección vacía conserva límites de autoridad',()=>{
    const r=summarizeHistoricalSelection([]);expect(r).toMatchObject({count:0,groups:[],seriesSequences:[],reviewRequired:true,accountingApproved:false});
  });
  it('hash es estable por orden, cambia al modificar detalle completo',()=>{
    const a=f.exported(2).documents,r=summarizeHistoricalSelection(a);a.reverse();expect(summarizeHistoricalSelection(a).selectionSha256).toBe(r.selectionSha256);
    a[0].customer.legalName='OTRO FICTICIO';expect(summarizeHistoricalSelection(a).selectionSha256).not.toBe(r.selectionSha256);
  });
  it('detecta duplicados y no los oculta al conciliar',()=>{
    const a=f.document();expect(()=>summarizeHistoricalSelection([a,a])).toThrow(/DUPLICATE_IDENTITY/);
  });
  it('igualdad declarada sólo prueba totales, no cierre ni autorización',()=>{
    const s=f.exported(2).documents,r=summarizeHistoricalSelection(s),c=compareHistoricalTotals(s,expected(r.groups));
    expect(c).toMatchObject({match:true,differenceCount:0,accountingApproved:false,reviewRequired:true,fiscalAuthority:false});
  });
  it('registra diferencias exactas de importe y conteo',()=>{
    const s=f.exported(2).documents,groups=structuredClone(summarizeHistoricalSelection(s).groups);groups[0].count=1;groups[0].amounts.payableAmount='235.99';
    const c=compareHistoricalTotals(s,expected(groups));expect(c.match).toBe(false);expect(c.differenceCount).toBe(2);
    expect(c.differences).toEqual(expect.arrayContaining([expect.objectContaining({field:'payableAmount',observed:'236.00',expected:'235.99'})]));
  });
  it('acota ejemplos de diferencias, no el conteo completo',()=>{
    const docs=Array.from({length:50},(_,i)=>f.document(1,i+1)),groups=structuredClone(summarizeHistoricalSelection(docs).groups);
    for(const g of groups){g.count=0;g.amounts.taxableAmount='0.00';g.amounts.igvAmount='0.00';g.amounts.payableAmount='0.00';}
    const c=compareHistoricalTotals(docs,expected(groups));expect(c.differenceCount).toBe(200);expect(c.differences).toHaveLength(100);expect(c.differencesTruncated).toBe(true);
  });
  it('no considera equivalentes grupo ausente y grupo inventado con cero filas',()=>{
    const s=[f.document()],g=summarizeHistoricalSelection(s).groups;
    expect(compareHistoricalTotals(s,expected([])).differences[0].field).toBe('groupPresence');
    expect(compareHistoricalTotals([],expected(g)).differenceCount).toBe(1);
  });
  it.each(['environment','datasetClass','schemaVersion'])('rechaza comparación ajena al perfil %s',field=>{
    const e:any=expected([]);e[field]='PRODUCTION';expect(()=>compareHistoricalTotals([],e)).toThrow(/HISTORY_PROFILE_BLOCKED/);
  });
  it.each(['issuerRuc','currencyCode','documentTypeCode','series'])('tipo de dimensión %s inválido se bloquea limpiamente',field=>{
    const g:any=structuredClone(summarizeHistoricalSelection([f.document()]).groups[0]);g[field]={};
    expect(()=>compareHistoricalTotals([],expected([g]))).toThrow(/INVALID_DIMENSION/);
  });
  it('duplicado en reporte esperado no se sobrescribe',()=>{
    const g=summarizeHistoricalSelection([f.document()]).groups[0];expect(()=>compareHistoricalTotals([],expected([g,g]))).toThrow(/DUPLICATE_GROUP/);
  });
  it('no ejecuta getters en reporte de un supuesto cliente',()=>{
    const getter=vi.fn(),e:any=expected([]);Object.defineProperty(e,'groups',{enumerable:true,get:getter});
    expect(()=>compareHistoricalTotals([],e)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it.each(['NaN','1e3','-1.00','01.00','0.001'])('importe esperado %s se rechaza',amount=>{
    const g=structuredClone(summarizeHistoricalSelection([f.document()]).groups[0]);g.amounts.payableAmount=amount;
    expect(()=>compareHistoricalTotals([],expected([g]))).toThrow(/INVALID_MONEY/);
  });
});
