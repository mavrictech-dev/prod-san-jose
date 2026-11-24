/** Shared native catalog and Billing policy vocabulary. Percentages are decimal strings. */
export const NATURAL_REGIONS = [{code:'COSTA',label:'Costa'},{code:'SIERRA',label:'Sierra'},{code:'SELVA',label:'Selva'}] as const;
export const TAX_TREATMENTS = [{code:'10',label:'Gravado',scheme:'1000',name:'IGV',type:'VAT'},{code:'20',label:'Exonerado',scheme:'9997',name:'EXO',type:'VAT'},{code:'30',label:'Inafecto',scheme:'9998',name:'INA',type:'FRE'}] as const;
export const PRODUCT_UNITS = [{code:'GLL',description:'Galón'},{code:'LTR',description:'Litro'},{code:'NIU',description:'Unidad'},{code:'KGM',description:'Kilogramo'},{code:'M3',description:'Metro cúbico'},{code:'HUR',description:'Hora'},{code:'ZZ',description:'Servicio'}] as const;
export type TaxTreatment = typeof TAX_TREATMENTS[number]['code'];
export type TaxPolicy = { region: typeof NATURAL_REGIONS[number]['code']; regime:'GENERAL'|'CUSTOM'; rate:string; defaultTreatment:TaxTreatment; allowExempt:boolean; allowUnaffected:boolean; validFrom:string };
export type TaxPolicyView = {companyId:number;branchId:string|null;revision:number;rucRevision:number;branchRevision:number;overridden:boolean;source:'RUC'|'BRANCH'|'DEFAULT';policy:TaxPolicy;inherited:TaxPolicy};
export const DEFAULT_TAX_POLICY: TaxPolicy = {region:'COSTA',regime:'GENERAL',rate:'18.00',defaultTreatment:'10',allowExempt:false,allowUnaffected:false,validFrom:'2026-01-01'};
export function canonicalCatalogName(value:string){return value.trim().replace(/\s+/gu,' ').toLocaleLowerCase('es-PE');}
export function validTaxRate(value:unknown):value is string {return typeof value==='string'&&/^(?:[0-9]|[1-9][0-9])(?:\.[0-9]{1,2})?$/.test(value)&&Number(value)>0&&Number(value)<=100;}
export function allowedTaxTreatment(policy:TaxPolicy,code:string){return code==='10'||code==='20'&&policy.allowExempt||code==='30'&&policy.allowUnaffected;}
export function effectiveTax(policy:TaxPolicy,code:string){if(!allowedTaxTreatment(policy,code))throw Error('Tratamiento no habilitado por la política del emisor/sede');return {taxAffectationCode:code as TaxTreatment,igvRate:code==='10'?policy.rate:'0'};}
