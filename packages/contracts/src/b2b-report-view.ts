/** Public aggregate contract only. Input must already be detached JSON.
 * No owner rows, tokens, grants or fiscal-acceptance assertions are exposed. */
export const Phase8ReportTypes=['01','03','07','08','09','31','NV'] as const;
export type Phase8ReportType=typeof Phase8ReportTypes[number];
const fail=():never=>{throw new Error('INVALID_REPORT_VIEW');};
function object(v:any){if(!v||typeof v!=='object'||Array.isArray(v))fail();}
function fields(v:any,allowed:string[],required=allowed){object(v);if(Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k)))fail();}
const integer=(v:any,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const uuid=(v:any)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const sha=(v:any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=(v:any)=>typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const instant=(v:any)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const decimal=(v:any,signed=false)=>typeof v==='string'&&(signed?/^-?\d{1,35}\.\d{2,12}$/:/^\d{1,35}\.\d{2,12}$/).test(v);
const quantity=(v:any)=>typeof v==='string'&&/^\d{1,35}(?:\.\d{1,12})?$/.test(v);
const fixed=(v:string)=>{const negative=v.startsWith('-'),[whole,fraction='']=v.replace(/^-/,'').split('.');return (BigInt(whole)*10n**12n+BigInt(fraction.padEnd(12,'0')))*(negative?-1n:1n);};
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
function types(v:any){if(!Array.isArray(v)||!v.length||v.length>7||new Set(v).size!==v.length||v.some(t=>!Phase8ReportTypes.includes(t))||v.some((t,i)=>i>0&&t<=v[i-1]))fail();}
function normalized(v:any){fields(v,['issuerId','issuerRuc','environment','from','to','types','branchId','pointId','seriesId'],['issuerId','environment','from','to','types']);
 if(!integer(v.issuerId,1)||v.environment!=='BETA'||!date(v.from)||!date(v.to)||v.from>v.to||Date.parse(v.to)-Date.parse(v.from)>366*86400000||v.issuerRuc!==undefined&&!/^\d{11}$/.test(v.issuerRuc))fail();types(v.types);for(const k of ['branchId','pointId','seriesId'])if(v[k]!==undefined&&!uuid(v[k]))fail();}
const mime:Record<string,string>={CSV:'text/csv; charset=utf-8',XLSX:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',PDF:'application/pdf'};
export function assertPhase8ReportView(input:unknown,mode:'dashboard'|'create'|'read',expected?:{id?:string;format?:string;filters?:unknown}):any{
 const v=input as any;fields(v,['schemaVersion','environment','source','candidateOnly','fiscalAuthority','data',...(mode==='create'?['replayed']:[])]);
 if(v.schemaVersion!=='factuez.b2b.reports.v1'||v.environment!=='BETA'||!['BILLING_01_03','BILLING_OWNER_SOURCES'].includes(v.source)||v.candidateOnly!==true||v.fiscalAuthority!==false||mode==='create'&&typeof v.replayed!=='boolean')fail();
 const extended=v.source==='BILLING_OWNER_SOURCES',d=v.data;
 if(mode!=='dashboard'){
  if(expected?.filters&&extended!==(expected.filters as any).types.some((t:string)=>!['01','03'].includes(t)))fail();
  fields(d,['id','state','revision','format','createdAt','capturedAt','captureSha256','count','content',...(extended?['types']:[])]);
  if(!uuid(d.id)||expected?.id&&expected.id!==d.id||!Object.hasOwn(mime,d.format)||expected?.format&&expected.format!==d.format||!instant(d.createdAt)||!instant(d.capturedAt)||!sha(d.captureSha256)||!integer(d.count,0,10000))fail();
  if(extended){types(d.types);if(!d.types.some((t:string)=>!['01','03'].includes(t)))fail();if(expected?.filters&&canonical(d.types)!==canonical((expected.filters as any).types))fail();}
  if(d.state==='QUEUED'){if(d.revision!==1||d.content!==null)fail();}
  else if(d.state==='READY'){if(d.revision!==2)fail();fields(d.content,['sha256','mediaType','fileName','sizeBytes']);if(!sha(d.content.sha256)||d.content.mediaType!==mime[d.format]||d.content.fileName!==`b2b-report-${d.id}.${d.format.toLowerCase()}`||!integer(d.content.sizeBytes,1,24*1024*1024))fail();}
  else fail();return v;
 }
 fields(d,['capturedAt','captureSha256','filters','count','groups',...(extended?['coverage','netSales','transfers']:[])]);normalized(d.filters);
 if(!instant(d.capturedAt)||!sha(d.captureSha256)||!integer(d.count,0,10000)||extended!==d.filters.types.some((t:string)=>!['01','03'].includes(t))||expected?.filters&&canonical(d.filters)!==canonical(expected.filters)||!Array.isArray(d.groups)||d.groups.length>(extended?40:8))fail();
 let total=0,previous='';const net=new Map<string,bigint>();
 for(const g of d.groups){fields(g,['currency','type','local','count','payableAmount','taxableAmount','igvAmount','missingTaxableCount','missingIgvCount']);
  const key=[g.currency,g.type,g.local].join(':');if(!['PEN','USD'].includes(g.currency)||!d.filters.types.includes(g.type)||['09','31'].includes(g.type)||!['ISSUED','CANCELLED','COMPLETED','CONVERTED'].includes(g.local)||!integer(g.count,1,10000)||key<=previous)fail();
  if(g.type==='NV'?!['CANCELLED','COMPLETED','CONVERTED'].includes(g.local):!['ISSUED','CANCELLED'].includes(g.local))fail();previous=key;total+=g.count;
  for(const name of ['payableAmount','taxableAmount','igvAmount'])if(g[name]!==null&&(!decimal(g[name],extended)||g.type!=='07'&&g[name].startsWith('-')||g.type==='07'&&fixed(g[name])>0n))fail();
  if(g.payableAmount===null)fail();for(const [amount,n]of [['taxableAmount','missingTaxableCount'],['igvAmount','missingIgvCount']])if(!integer(g[n],0,g.count)||(g[amount]===null)!==(g[n]>0))fail();
  if(g.local==='ISSUED'&&['01','03','07','08'].includes(g.type))net.set(g.currency,(net.get(g.currency)??0n)+fixed(g.payableAmount));
 }
 if(!extended){if(total!==d.count)fail();return v;}
 if(!Array.isArray(d.coverage)||d.coverage.length!==d.filters.types.length||!Array.isArray(d.netSales)||d.netSales.length!==net.size||!Array.isArray(d.transfers)||d.transfers.length>10000)fail();
 for(const [index,c]of d.coverage.entries()){
  fields(c,['type','representations','dataParity','financialContribution','authorization','metadataCapability','metadataProvidesReportRows','finalFiscalParity','fiscalAcceptance','authorizedForTransfer','sourceActivation','metadataCaptured','source','consistency']);
  const guide=['09','31'].includes(c.type),commercial=c.type==='NV',correction=['07','08'].includes(c.type);
  if(c.type!==d.filters.types[index]||canonical(c.representations)!=='["CSV","XLSX","PDF"]'||c.dataParity!==(guide?'LOCAL_NUMBERED_GUIDE':commercial?'LOCAL_COMPLETED_COMMERCIAL':'CURRENT_OWNER_DOCUMENT')||
   c.financialContribution!==(guide||commercial?'NONE':c.type==='07'?'NEGATIVE_LOCAL_AMOUNT':'POSITIVE_LOCAL_AMOUNT')||
   c.authorization!==(guide?'EXPLICIT_NUMBERED_GUIDE_READ':correction?'EXPLICIT_CORRECTION_PAIR_READ':commercial?'EXACT_COMMERCIAL_ACTOR_READ':'EXACT_DOCUMENT_BINDING')||
   c.metadataCapability!==(guide?'EXISTING_PRIVATE_HTTP_READ_ONLY':'NOT_APPLICABLE')||c.metadataProvidesReportRows!==false||c.finalFiscalParity!==false||c.fiscalAcceptance!=='NOT_ASSERTED'||c.authorizedForTransfer!==false||
   c.sourceActivation!==(correction?'REQUIRES_COMPOSED_CORRECTION_READ_AUTHORITY':'REQUIRES_EXPLICIT_OWNER_COMPOSITION')||typeof c.metadataCaptured!=='boolean'||!guide&&c.metadataCaptured||
   c.source!==(guide?'BILLING_LOCAL_NUMBERED_GUIDE':commercial?'BILLING_COMMERCIAL':'BILLING_DOCUMENT_LATEST')||c.consistency!=='OWNER_CAPTURE_NOT_A_CROSS_SOURCE_TRANSACTION')fail();
 }
 const seen=new Set<string>();for(const t of d.transfers){fields(t,['type','id','grossWeight','weightUnit','quantities']);if(!['09','31'].includes(t.type)||!d.filters.types.includes(t.type)||!uuid(t.id)||!quantity(t.grossWeight)||!['KGM','TNE'].includes(t.weightUnit)||!Array.isArray(t.quantities)||t.quantities.length>1000||seen.has(t.type+':'+t.id))fail();
  seen.add(t.type+':'+t.id);for(const q of t.quantities){fields(q,['unitCode','quantity']);if(typeof q.unitCode!=='string'||!/^[A-Z0-9]{1,10}$/.test(q.unitCode)||!quantity(q.quantity))fail();}total++;
 }if(total!==d.count)fail();
 let prior='';for(const n of d.netSales){fields(n,['currency','payableAmount']);if(!['PEN','USD'].includes(n.currency)||n.currency<=prior||!decimal(n.payableAmount,true)||!net.has(n.currency)||fixed(n.payableAmount)!==net.get(n.currency))fail();prior=n.currency;}
 return v;
}
