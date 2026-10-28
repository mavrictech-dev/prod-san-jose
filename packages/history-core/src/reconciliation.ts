import { assertHistory, AMOUNT_KEYS, historicalSha256, historyInteger, historyJson, historyObject,
  HISTORY_FULL_LIMITS, prepareHistoricalImport, type HistoricalAmounts } from './index';

const profile = Object.freeze({ environment:'BETA' as const, datasetClass:'SYNTHETIC' as const,
  fiscalAuthority:false as const, cdrAuthenticityVerified:false as const, transmission:false as const,
  countersChanged:false as const, accountingApproved:false as const, reviewRequired:true as const });
const money = (value:bigint) => `${value/100n}.${(value%100n).toString().padStart(2,'0')}`;
const key = (r:{issuerRuc:string;currencyCode:string;documentTypeCode:string;series:string}) =>
  JSON.stringify([r.issuerRuc,r.currencyCode,r.documentTypeCode,r.series]);
type Group = {issuerRuc:string;currencyCode:string;documentTypeCode:string;series:string;count:number;amounts:HistoricalAmounts};

/** Selection totals, NOT sales net of notes or proof of XML/CDR authenticity. */
export function summarizeHistoricalSelection(input:unknown) {
  const values=historyJson(input);
  assertHistory(Array.isArray(values)&&values.length<=HISTORY_FULL_LIMITS.rows,'RECONCILIATION_LIMIT');
  const mappings=new Map<string,unknown>();
  for(const row of values) { assertHistory(row?.ownership?.mappingId,'INVALID_SNAPSHOT'); mappings.set(row.ownership.mappingId,row.ownership); }
  const plan=values.length?prepareHistoricalImport({schemaVersion:'factuez.history-full.v1',environment:'BETA',datasetClass:'SYNTHETIC',
    exportId:'00000000-0000-4000-8000-000000000001',originSystem:'RESTOAPP',mappings:[...mappings.values()],documents:values}):null;
  const snapshots=plan?.records.map(r=>r.snapshot)??[];
  const sums=new Map<string,{group:Omit<Group,'amounts'>;amounts:Record<string,bigint>}>();
  const sequences=new Map<string,{issuerRuc:string;documentTypeCode:string;series:string;numbers:number[]}>();
  const declaredStates:Record<string,number>={NOT_DECLARED:0,DECLARED_ACCEPTED:0,DECLARED_REJECTED:0,DECLARED_VOIDED:0};
  let missingCdr=0,missingSignedXml=0,referencesOutsideSelection=0;
  const diagnostics:Array<{code:string;fullNumber:string;issuerRuc:string}>=[];
  const identities=new Set(snapshots.map(s=>JSON.stringify([s.ownership.issuerRuc,s.ownership.documentTypeCode,s.ownership.series,s.number])));
  for(const s of snapshots) {
    const m=s.ownership,dimension={issuerRuc:m.issuerRuc,currencyCode:s.currencyCode,documentTypeCode:m.documentTypeCode,series:m.series};
    let sum=sums.get(key(dimension));
    if(!sum){sum={group:{...dimension,count:0},amounts:Object.fromEntries(AMOUNT_KEYS.map(k=>[k,0n]))};sums.set(key(dimension),sum);}
    sum.group.count++;
    for(const k of AMOUNT_KEYS)sum.amounts[k]+=BigInt(s.amounts[k].replace('.',''));
    const sequenceKey=JSON.stringify([m.issuerRuc,m.documentTypeCode,m.series]);
    let sequence=sequences.get(sequenceKey);
    if(!sequence){sequence={issuerRuc:m.issuerRuc,documentTypeCode:m.documentTypeCode,series:m.series,numbers:[]};sequences.set(sequenceKey,sequence);}
    sequence.numbers.push(Number(s.number));
    declaredStates[s.sourceEvidence.declaredStatus]++;
    if(!s.artifacts.some(a=>a.kind==='CDR_XML'||a.kind==='CDR_ZIP'))missingCdr++;
    if(!s.artifacts.some(a=>a.kind==='SIGNED_XML'))missingSignedXml++;
    if(s.reference&&!identities.has(JSON.stringify([s.reference.issuerRuc,s.reference.documentTypeCode,s.reference.series,s.reference.number]))){
      referencesOutsideSelection++;
      if(diagnostics.length<100)diagnostics.push({code:'REFERENCE_NOT_IN_SELECTION',fullNumber:`${m.series}-${s.number}`,issuerRuc:m.issuerRuc});
    }
  }
  const groups:Group[]=[...sums.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,s])=>({...s.group,
    amounts:Object.fromEntries(AMOUNT_KEYS.map(k=>[k,money(s.amounts[k])])) as Record<typeof AMOUNT_KEYS[number],string>}));
  // Numbering is independent of currency: splitting by currency invents gaps.
  const seriesSequences=[...sequences.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,s])=>{
    s.numbers.sort((a,b)=>a-b);let missingCount=0,rangeCount=0;const ranges:Array<{from:string;to:string}>=[];
    for(let i=1;i<s.numbers.length;i++)if(s.numbers[i]>s.numbers[i-1]+1){
      missingCount+=s.numbers[i]-s.numbers[i-1]-1;rangeCount++;
      if(ranges.length<20)ranges.push({from:String(s.numbers[i-1]+1),to:String(s.numbers[i]-1)});
    }
    const {numbers,...owner}=s;return {...owner,count:numbers.length,minNumber:String(numbers[0]),maxNumber:String(numbers.at(-1)),
      missingCount,rangeCount,ranges,rangesTruncated:rangeCount>ranges.length};
  });
  return {schemaVersion:'factuez.history-reconciliation.v1' as const,...profile,count:snapshots.length,groups,seriesSequences,declaredStates,
    evidence:{missingCdr,missingSignedXml,declaredOnly:true as const},referencesOutsideSelection,diagnostics,
    diagnosticsTruncated:referencesOutsideSelection>diagnostics.length,
    selectionSha256:historicalSha256(plan?.records.map(r=>({recordId:r.recordId,snapshotSha256:r.snapshotSha256}))??[])};
}
export type HistoryReconciliation = ReturnType<typeof summarizeHistoricalSelection>;

/** Comparison of synthetic declared totals. Never an accounting/cutover approval. */
export function compareHistoricalTotals(snapshotInput:unknown,expectedInput:unknown) {
  const actual=summarizeHistoricalSelection(snapshotInput),expected=historyJson(expectedInput);
  historyObject(expected,['schemaVersion','environment','datasetClass','groups']);
  assertHistory(expected.schemaVersion==='factuez.history-expected-totals.v1'&&expected.environment==='BETA'&&expected.datasetClass==='SYNTHETIC','HISTORY_PROFILE_BLOCKED');
  assertHistory(Array.isArray(expected.groups)&&expected.groups.length<=HISTORY_FULL_LIMITS.rows,'RECONCILIATION_LIMIT');
  const declared=new Map<string,Group>();
  for(const g of expected.groups){
    historyObject(g,['issuerRuc','currencyCode','documentTypeCode','series','count','amounts']);
    assertHistory(['issuerRuc','currencyCode','documentTypeCode','series'].every(k=>typeof g[k]==='string')&&/^00000000[0-9]{3}$/.test(g.issuerRuc)&&/^(PEN|USD)$/.test(g.currencyCode)&&
      /^(01|03|07|08)$/.test(g.documentTypeCode)&&/^[FB][A-Z0-9]{3}$/.test(g.series)&&
      (g.documentTypeCode!=='01'||g.series.startsWith('F'))&&(g.documentTypeCode!=='03'||g.series.startsWith('B')),'INVALID_DIMENSION');
    historyInteger(g.count,HISTORY_FULL_LIMITS.rows,0);historyObject(g.amounts,AMOUNT_KEYS);
    for(const k of AMOUNT_KEYS)assertHistory(typeof g.amounts[k]==='string'&&/^(0|[1-9][0-9]{0,19})\.[0-9]{2}$/.test(g.amounts[k]),'INVALID_MONEY');
    assertHistory(!declared.has(key(g)),'DUPLICATE_GROUP');declared.set(key(g),g);
  }
  const observed=new Map(actual.groups.map(g=>[key(g),g]));
  const differences:Array<{issuerRuc:string;currencyCode:string;documentTypeCode:string;series:string;field:string;observed:string|null;expected:string|null}>=[];
  let differenceCount=0;
  function difference(g:Group,field:string,seen:string|null,wanted:string|null){
    differenceCount++;if(differences.length<100){const{issuerRuc,currencyCode,documentTypeCode,series}=g;differences.push({issuerRuc,currencyCode,documentTypeCode,series,field,observed:seen,expected:wanted});}
  }
  for(const k of [...new Set([...observed.keys(),...declared.keys()])].sort()){
    const a=observed.get(k),e=declared.get(k),g=a??e!;
    if(!a||!e){difference(g,'groupPresence',a?'PRESENT':null,e?'PRESENT':null);continue;}
    if(a.count!==e.count)difference(g,'count',String(a.count),String(e.count));
    for(const field of AMOUNT_KEYS)if(a.amounts[field]!==e.amounts[field])difference(g,field,a.amounts[field],e.amounts[field]);
  }
  return {schemaVersion:'factuez.history-comparison.v1' as const,...profile,selectionSha256:actual.selectionSha256,
    expectedSha256:historicalSha256(expected),match:differenceCount===0,differenceCount,differences,
    differencesTruncated:differenceCount>differences.length};
}
