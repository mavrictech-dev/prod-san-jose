import {fiscalSnapshotSha256 as hash} from '@factuez/sunat-core/dist/fiscal-note';
import type {CarrierReferenceVerifyInput} from '../application/carrier-reference-verifier';
import type {CarrierReference09Evidence} from '@factuez/sunat-core/dist/carrier-guide-profile';
import {carrierReferenceLimits,referenceRecord,referenceRequire,normalizeCarrierReference} from './carrier-reference-validation';
export const CARRIER_VALIDATION_PATH='/internal/b2b/carrier-reference-validation';
export const CARRIER_REQUEST_VERSION='factuez.b2b.carrier-reference-validation.request.v1';
export const CARRIER_RESPONSE_VERSION='factuez.b2b.carrier-reference-validation.response.v1';
export function carrierReferenceRequest(raw:unknown,now:string):{request:any;input:CarrierReferenceVerifyInput}{
 referenceRecord(raw,['schemaVersion','requestId','environment','asOf','input']);const request=raw as any;
 referenceRequire(request.schemaVersion===CARRIER_REQUEST_VERSION&&request.environment==='BETA'&&typeof request.requestId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.requestId));
 referenceRequire(typeof request.asOf==='string'&&Number.isFinite(Date.parse(request.asOf))&&new Date(request.asOf).toISOString()===request.asOf&&Date.parse(now)-Date.parse(request.asOf)>=-2000&&Date.parse(now)-Date.parse(request.asOf)<=carrierReferenceLimits.freshMs);
 const i=request.input;referenceRecord(i,['ownerSnapshot','ownerSnapshotSha256','projection','projectionSha256','signedXmlBase64','signedXmlSha256','cdrXmlBase64','cdrSha256']);
 const decode=(v:unknown)=>{referenceRequire(typeof v==='string'&&v.length>0&&v.length<=Math.ceil(carrierReferenceLimits.artifact/3)*4);const b=Buffer.from(v,'base64');referenceRequire(b.toString('base64')===v);return b;};
 const input=normalizeCarrierReference({ownerSnapshot:i.ownerSnapshot,ownerSnapshotSha256:i.ownerSnapshotSha256,projection:i.projection,projectionSha256:i.projectionSha256,
  signedXml:decode(i.signedXmlBase64),signedXmlSha256:i.signedXmlSha256,cdrXml:decode(i.cdrXmlBase64),cdrSha256:i.cdrSha256});
 referenceRequire(Buffer.byteLength(JSON.stringify(request))<=carrierReferenceLimits.request);return {request:JSON.parse(JSON.stringify(request)),input};
}
export function carrierReferenceResponse(request:any,acceptance:CarrierReference09Evidence['acceptance'],verifiedAt:string){
 return {schemaVersion:CARRIER_RESPONSE_VERSION,environment:'BETA',requestId:request.requestId,requestSha256:hash(request),verifiedAt,acceptance};
}
