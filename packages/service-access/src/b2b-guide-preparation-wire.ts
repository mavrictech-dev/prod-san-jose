import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {validB2bGuideBinding,b2bGuideBindingKey,type B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze,correctionEvidenceHash} from './b2b-correction-evidence-wire';
export const GUIDE_PREPARATION_GATES=Object.freeze(['NUMBER_RESERVATION','ESTABLISHMENT_MAPPING','CATALOGUES_AND_REGULATED_GOODS','OFFICIAL_XSL_RULES','XSD_ON_SIGNED_XML','SIGNATURE_AND_PKI','SUNAT_TRANSPORT_AND_CDR'] as const);
type Flags={candidateOnly:true;fiscalExecutionEnabled:false;transmissionAuthorized:false;authorizedForTransfer:false};
export type GuidePreparationWirePlan=Flags&{schemaVersion:'factuez.guide09-preparation-input.v1';draftId:string;draftRevision:string;draftBodySha256:string;
  issuer:{ruc:string;legalName:string};body:Record<string,any>;profile:'FACTUEZ-BETA-GRE09-PRIVATE04-PREPARATION-v1';planSha256:string;
  numberReserved:false;signatureVerified:false;officialRulesValidated:false;referenceVerification:'NOT_VERIFIED'};
export type GuidePreparationResponse=Flags&{schemaVersion:'factuez.b2b.guide-preparation.v1';binding:B2bGuideBinding;plan:GuidePreparationWirePlan;gates:string[]};
const FLAGS={candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false,authorizedForTransfer:false};
const PLAN_FLAGS={...FLAGS,numberReserved:false,signatureVerified:false,officialRulesValidated:false,referenceVerification:'NOT_VERIFIED'};
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))throw new Error();}
function flags(v:any,expected:Record<string,unknown>){for(const [k,x]of Object.entries(expected))if(v[k]!==x)throw new Error();}
function text(v:any,max:number){if(typeof v!=='string'||!v||v!==v.trim()||v.length>max||/[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(v))throw new Error();}
/** Wire integrity only, NOT a fiscal validator or proof of the issuer identity.
 * Keeps the public facade independent of Billing and the SUNAT engine. Owner
 * provenance still requires authenticated private transport and fresh scopes. */
export function validateGuidePreparationResponse(value:unknown,binding:B2bGuideBinding,id:string,ifMatch:string):GuidePreparationResponse{
  try{
    const r=correctionEvidenceFreeze(value) as GuidePreparationResponse;
    if(Buffer.byteLength(JSON.stringify(r))>512*1024)throw new Error();
    exact(r,['schemaVersion','binding','plan','gates',...Object.keys(FLAGS)]);flags(r,FLAGS);
    if(r.schemaVersion!=='factuez.b2b.guide-preparation.v1'||!validB2bGuideBinding(binding)||binding.guideType!=='09'||!validB2bGuideBinding(r.binding)||b2bGuideBindingKey(r.binding)!==b2bGuideBindingKey(binding)||JSON.stringify(r.gates)!==JSON.stringify(GUIDE_PREPARATION_GATES))throw new Error();
    const p=r.plan;exact(p,['schemaVersion','draftId','draftRevision','draftBodySha256','issuer','body','profile','planSha256',...Object.keys(PLAN_FLAGS)]);flags(p,PLAN_FLAGS);
    if(p.schemaVersion!=='factuez.guide09-preparation-input.v1'||p.profile!=='FACTUEZ-BETA-GRE09-PRIVATE04-PREPARATION-v1'||!b2bUuid(p.draftId)||p.draftId!==id||p.draftRevision!==ifMatch||!/^"v[1-9][0-9]{0,8}"$/.test(p.draftRevision)||!/^[a-f0-9]{64}$/.test(p.draftBodySha256)||!/^[a-f0-9]{64}$/.test(p.planSha256))throw new Error();
    exact(p.issuer,['ruc','legalName']);if(p.issuer.ruc!==binding.anchor.issuerRuc)throw new Error();text(p.issuer.legalName,200);
    const b=p.body;exact(b,['issueDate','transferDate','reasonCode','origin','destination','sender','recipient','grossWeight','weightUnit','transport','items','references','regulatedGoods']);
    if(b.reasonCode!=='04'||b.regulatedGoods!==false||!Array.isArray(b.references)||b.references.length||!['KGM','TNE'].includes(b.weightUnit)||typeof b.grossWeight!=='string'||!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,3})?$/.test(b.grossWeight)||BigInt(b.grossWeight.replace('.',''))<=0n)throw new Error();
    if(typeof b.issueDate!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(b.issueDate)||Number(b.issueDate.slice(0,4))<2000||!Number.isFinite(Date.parse(b.issueDate))||new Date(b.issueDate).toISOString()!==b.issueDate||typeof b.transferDate!=='string'||!/^\d{4}-\d\d-\d\d$/.test(b.transferDate)||Number(b.transferDate.slice(0,4))<2000||new Date(b.transferDate+'T00:00:00Z').toISOString().slice(0,10)!==b.transferDate)throw new Error();
    const localDate=new Date(Date.parse(b.issueDate)-5*3600000).toISOString().slice(0,10);if(Number(localDate.slice(0,4))<2000||b.transferDate<localDate)throw new Error();
    for(const party of [b.sender,b.recipient]){exact(party,['ruc','legalName']);if(party.ruc!==p.issuer.ruc||party.legalName!==p.issuer.legalName)throw new Error();}
    for(const a of [b.origin,b.destination]){exact(a,['ubigeo','address','establishmentCode']);if(typeof a.ubigeo!=='string'||!/^\d{6}$/.test(a.ubigeo)||typeof a.establishmentCode!=='string'||!/^\d{4}$/.test(a.establishmentCode))throw new Error();text(a.address,300);}
    if(b.origin.establishmentCode===b.destination.establishmentCode||b.origin.ubigeo===b.destination.ubigeo&&b.origin.address===b.destination.address)throw new Error();
    const t=b.transport;exact(t,['mode','vehicle','driver']);exact(t.vehicle,['plate','registration']);exact(t.driver,['identityType','identityNumber','firstName','lastName','license']);
    if(t.mode!=='02'||typeof t.vehicle.plate!=='string'||!/^[A-Z0-9]{6,8}$/.test(t.vehicle.plate)||typeof t.vehicle.registration!=='string'||!/^[A-Z0-9]{1,15}$/.test(t.vehicle.registration)||!['1','4'].includes(t.driver.identityType)||typeof t.driver.identityNumber!=='string'||!(t.driver.identityType==='1'?/^[0-9]{8}$/:/^[A-Z0-9]{1,12}$/).test(t.driver.identityNumber)||typeof t.driver.license!=='string'||!/^[A-Z0-9]{1,10}$/.test(t.driver.license))throw new Error();
    text(t.driver.firstName,100);text(t.driver.lastName,100);
    if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)throw new Error();const codes=new Set<string>();
    for(const item of b.items){exact(item,['code','description','quantity','unitCode']);text(item.code,40);text(item.description,250);
      if(codes.has(item.code)||typeof item.quantity!=='string'||!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(item.quantity)||BigInt(item.quantity.replace('.',''))<=0n||typeof item.unitCode!=='string'||!/^[A-Z0-9]{2,3}$/.test(item.unitCode))throw new Error();codes.add(item.code);}
    const {planSha256,...unsigned}=p;
    if(correctionEvidenceHash(unsigned)!==planSha256||correctionEvidenceHash(b)!==p.draftBodySha256)throw new Error();
    return r;
  }catch{throw new B2bSecurityError(503,'INCONSISTENT_GUIDE_PREPARATION');}
}
