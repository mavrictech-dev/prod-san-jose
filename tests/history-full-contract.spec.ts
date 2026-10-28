import {describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {prepareHistoricalImport,validateHistoricalSnapshot,historicalSha256,historyJson,HISTORY_FULL_LIMITS} from '../packages/history-core/src';
const f=createRequire(import.meta.url)('./helpers/history-full-fixtures.cjs');

describe('histórico completo v1: candidato BETA, no comando de emisión',()=>{
  it('congela cliente/cabecera/ítems/impuestos/referencias y no modifica el export',()=>{
    const input=f.exported(2,true),before=JSON.stringify(input),p=prepareHistoricalImport(input);
    expect(JSON.stringify(input)).toBe(before);expect(p.records[0].snapshot.items[0].quantity).toBe('2.000000');
    expect(p.records[0].snapshot.customer.legalName).toBe('CLIENTE FICTICIO');
    expect(Object.isFrozen(p.records[0].snapshot.items[0].amounts)).toBe(true);
    input.documents[0].customer.legalName='MODIFICADO';expect(p.records[0].snapshot.customer.legalName).toBe('CLIENTE FICTICIO');
    expect(p).toMatchObject({candidateOnly:true,fiscalAuthority:false,cdrAuthenticityVerified:false,transmission:false,countersChanged:false});
  });
  it('orden del export no cambia plan; los cambios de detalle sí',()=>{
    const input=f.exported(3),p=prepareHistoricalImport(input);input.documents.reverse();
    expect(prepareHistoricalImport(input).planSha256).toBe(p.planSha256);
    input.documents[0].customer.legalName='OTRO FICTICIO';expect(prepareHistoricalImport(input).planSha256).not.toBe(p.planSha256);
  });
  it.each(['01','03','07','08'])('snapshot %s completo conserva valor de nota positivo',type=>{
    const d=f.document(1,1,type);expect(validateHistoricalSnapshot(d).amounts.payableAmount).toBe('118.00');
    expect(validateHistoricalSnapshot(d).reference!==null).toBe(['07','08'].includes(type));
  });
  it('separa RUC, monedas, sedes y tipos sin inventar propiedad',()=>{
    const input=f.exported();const d=f.document(1,2,'01');d.currencyCode='USD';input.documents.push(d);input.mappings.push(d.ownership);
    const p=prepareHistoricalImport(input);expect(p.records).toHaveLength(2);expect(new Set(p.records.map(r=>r.recordId)).size).toBe(2);
  });
  it('crédito conserva cuotas exactas, no dispara cobro ni correo',()=>{
    const d=f.document();d.paymentTerms={type:'CREDITO',currencyCode:'PEN',pendingAmount:'118',installments:[{amount:'59',dueDate:'2026-10-10'},{amount:'59',dueDate:'2026-11-10'}]};
    expect(validateHistoricalSnapshot(d).paymentTerms).toMatchObject({type:'CREDITO',pendingAmount:'118.00',installments:[{amount:'59.00'},{amount:'59.00'}]});
  });
  it('un status aceptado declarado nunca acredita confianza del CDR',()=>{
    const d=f.document();d.sourceEvidence.declaredStatus='DECLARED_ACCEPTED';d.sourceEvidence.responseCode='0';
    const p=prepareHistoricalImport({...f.exported(),documents:[d]});expect(p.cdrAuthenticityVerified).toBe(false);
    expect(p.records[0].snapshot.sourceEvidence.declaredStatus).toBe('DECLARED_ACCEPTED');
  });
  const mutations=[
    (x:any)=>x.environment='PRODUCTION', (x:any)=>x.datasetClass='AUTHORIZED_COPY', (x:any)=>x.schemaVersion='v2',
    (x:any)=>x.outbox={send:true},(x:any)=>x.documents=[],(x:any)=>x.mappings=[],
    (x:any)=>x.documents.push(JSON.parse(JSON.stringify(x.documents[0]))),
    (x:any)=>x.documents[0].environment='PRODUCTION',(x:any)=>x.documents[0].ownership.issuerRuc='20615878481',
    (x:any)=>x.documents[0].issuer.ruc='00000000002',(x:any)=>x.documents[0].sourceDocumentId='wrong',
    (x:any)=>x.documents[0].items=[],(x:any)=>x.documents[0].items[0].lineNumber=2,
    (x:any)=>x.documents[0].items[0].quantity='0',(x:any)=>x.documents[0].items[0].quantity='2e3',
    (x:any)=>x.documents[0].items[0].quantity='1.1234567',(x:any)=>x.documents[0].items[0].amounts.taxableAmount='99',
    (x:any)=>x.documents[0].amounts.payableAmount='119',(x:any)=>x.documents[0].tax[0].taxAmount='17',
    (x:any)=>x.documents[0].tax.push({...x.documents[0].tax[0]}),(x:any)=>x.documents[0].issueDate='2026-02-30T10:00:00Z',
    (x:any)=>x.documents[0].issueDate='2026-01-01T24:00:00Z',(x:any)=>x.documents[0].issueDate='2026-01-01T10:00:00+14:01',
    (x:any)=>x.documents[0].customer.email='wrong',(x:any)=>x.documents[0].customer.password='secret',
    (x:any)=>x.documents[0].sourceEvidence.authenticity='VERIFIED',(x:any)=>x.documents[0].sourceEvidence.accepted=true,
    (x:any)=>x.documents[0].number='01',(x:any)=>x.documents[0].number='0',
    (x:any)=>x.documents[0].ownership.series='FQ01',(x:any)=>x.documents[0].reference={send:true},
    (x:any)=>x.documents[0].paymentTerms={type:'CREDITO',currencyCode:'PEN',pendingAmount:'118',installments:[{amount:'117',dueDate:'2026-11-01'}]},
    (x:any)=>x.documents[0].paymentTerms={type:'CREDITO',currencyCode:'USD',pendingAmount:'118',installments:[{amount:'118',dueDate:'2026-11-01'}]},
    (x:any)=>x.documents[0].ownership.branchId=f.uuid(300),
  ];
  it.each(mutations)('rechaza contrato incompleto/inconsistente o comandos extra %#',mutate=>{
    const input=f.exported();mutate(input);expect(()=>prepareHistoricalImport(input)).toThrow();
  });
  it.each(['../a.xml','CON.xml','a.p12','a.xml:stream','password.xml','a\\b.xml'])('rechaza artefacto %s sin I/O',originalName=>{
    const input=f.exported(1,true);input.documents[0].artifacts[0].originalName=originalName;expect(()=>prepareHistoricalImport(input)).toThrow();
  });
  it.each(['issuer','customer','items','sourceEvidence','artifacts'])('accessor %s no se ejecuta',key=>{
    const input=f.exported(),getter=vi.fn();Object.defineProperty(input.documents[0],key,{enumerable:true,get:getter});
    expect(()=>prepareHistoricalImport(input)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it('proxy no activa trampas ni toJSON ejecutable',()=>{
    const trap=vi.fn();expect(()=>prepareHistoricalImport(new Proxy(f.exported(),{ownKeys:trap}))).toThrow();expect(trap).not.toHaveBeenCalled();
    expect(()=>historicalSha256({toJSON:trap})).toThrow();expect(trap).not.toHaveBeenCalled();
  });
  it.each([1,49,50,51,101])('lotes de 50 para %i documentos',count=>{
    const p=prepareHistoricalImport(f.exported(count));expect(p.batches.length).toBe(Math.ceil(count/50));
    expect(p.batches.flatMap(b=>b.records)).toHaveLength(count);expect(p.batches.at(-1)!.count).toBe(count%50||50);
  });
  it('limita volumen y no acepta array disperso',()=>{
    expect(()=>prepareHistoricalImport(f.exported(HISTORY_FULL_LIMITS.rows+1))).toThrow();
    const x=f.exported();delete x.documents[0];expect(()=>prepareHistoricalImport(x)).toThrow();
  });
  it('el límite JSON incluye escapes, no sólo longitud de texto bruto',()=>{
    const escaped='\u0000'.repeat(16_000);
    expect(()=>historyJson(Array(200).fill(escaped))).toThrow(/JSON_LIMIT/);
    expect(historyJson(Array(200).fill('a'.repeat(16_000)))).toHaveLength(200);
  });
  it('texto individual excesivo se rechaza antes de serializar',()=>{
    expect(()=>historyJson('a'.repeat(16_001))).toThrow(/JSON_LIMIT/);
  });
  it('un UUID de punto no puede declararse para dos sedes/RUC',()=>{
    const input=f.exported(),d=f.document(2,2);d.ownership.emissionPointId=input.mappings[0].emissionPointId;
    input.documents.push(d);input.mappings.push(d.ownership);expect(()=>prepareHistoricalImport(input)).toThrow(/MAPPING_CONFLICT/);
  });
});
