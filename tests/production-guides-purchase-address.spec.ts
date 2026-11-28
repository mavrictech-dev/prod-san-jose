import {describe,it,expect} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildProductionGuidesXml,validateProductionGuidesSnapshot,productionGuidesHash as hash} from '../packages/sunat-core/src/production-guides';
import {validatePurchaseGuide09Route} from '../packages/sunat-core/src/production-guides-purchase';
import {validateGreAdministration,emptyGreAdministration} from '../packages/contracts/src/gre-administration';
import {ProductionGuidesCatalogueRules} from '../services/sunat-service/src/production-guides-crypto';
import {validateOfficialGreXml} from '../services/sunat-service/src/production-guides-official-rules';
import {signLocalGuideXml} from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import {createGuideSidecarPki} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {purchaseSnapshot,purchaseCatalogue} from './production-guides-purchase.fixture';
import {fuelSnapshot} from './production-guides-hydrocarbon.fixture';
import {safeXml} from '../services/sunat-service/src/infrastructure/sunat/safe-xml';

const output=resolve('output/gre-series-administration-lifecycle-20261127/t099/xml');
describe('Compra02 declared addresses independent of authorizing branch',()=>{
 it.each(['neither','origin','destination','both'] as const)('signs and passes official XSD/XSL: %s codes',async mode=>{
  const s=purchaseSnapshot(),b=s.body as any,original=structuredClone(s);
  b.origin.ubigeo='070106';b.destination.ubigeo='150502';
  // The issuing branch stays 0001. A declared buyer arrival may be another establishment.
  b.destination.establishmentCode='0002';
  if(mode==='neither'||mode==='destination')delete b.origin.establishmentCode;
  if(mode==='neither'||mode==='origin')delete b.destination.establishmentCode;
  const frozen=structuredClone(s),c=purchaseCatalogue(s);
  for(const approval of c.hydrocarbonApprovals!)approval.routeUbigeos=[b.origin.ubigeo,b.destination.ubigeo];
  expect(validateProductionGuidesSnapshot(s)).toEqual(frozen);
  await new ProductionGuidesCatalogueRules(c).validate(s,{rulesSha256:hash(c)} as any);
  const x=buildProductionGuidesXml(s),pki=createGuideSidecarPki(s.issuer.ruc);
  const signed=signLocalGuideXml({issuerRuc:s.issuer.ruc,documentType:'09',fullNumber:x.fullNumber,unsignedXml:x.xml},pki.issuer.pkcs12,pki.password);
  await validateOfficialGreXml(signed.xml,`${s.issuer.ruc}-09-${x.fullNumber}.xml`);
  const doc=safeXml(signed.xml),nodes=Array.from(doc.getElementsByTagName('cbc:AddressTypeCode'));
  expect(nodes).toHaveLength(mode==='neither'?0:mode==='both'?2:1);
  for(const node of nodes)expect(node.getAttribute('listID')).toBe(node.parentNode!.nodeName==='cac:DespatchAddress'?b.supplier.ruc:s.issuer.ruc);
  for(const [party,ruc]of [['cac:SellerSupplierParty',b.supplier.ruc],['cac:DespatchSupplierParty',s.issuer.ruc]]){
   const identity=doc.getElementsByTagName(party)[0].getElementsByTagName('cbc:ID')[0];
   expect(identity.getAttribute('schemeID')).toBe('6');expect(identity.textContent).toBe(ruc);
  }
  expect(x.xml).not.toContain('undefined');expect(x.xml).not.toContain('>0000</cbc:AddressTypeCode>');
  mkdirSync(output,{recursive:true});writeFileSync(resolve(output,mode+'.signed.xml'),signed.xml);writeFileSync(resolve(output,mode+'.proof.json'),JSON.stringify({synthetic:true,mode,issuerRuc:s.issuer.ruc,authorizingEstablishment:s.scope.establishmentCode,origin:b.origin,destination:b.destination,xmlSha256:signed.xmlSha256,officialXsdXsl:'passed',sunatSubmission:false},null,2));
  expect(s).toEqual(frozen);expect(original.scope.establishmentCode).toBe('0001');
 },60000);
 it.each(['',' ',null,undefined,'000','00000','XXXX',' 0001','0001 ',1234,'N/A'] as const)('rejects present malformed code %s in body and preparation',value=>{
  for(const side of ['origin','destination'] as const){
   const s=purchaseSnapshot(),b=s.body as any;b[side].establishmentCode=value;
   expect(()=>validateProductionGuidesSnapshot(s)).toThrow();expect(()=>validatePurchaseGuide09Route(b)).toThrow();
   const d=emptyGreAdministration();d.routes=[{id:'00000000-0000-4000-8000-000000000401',active:true,name:'SYNTHETIC',origin:b.origin,destination:b.destination}];
   expect(()=>validateGreAdministration(d)).toThrow();
  }
 });
 it('accepts explicit actual headquarters code without manufacturing it',()=>{
  const s=purchaseSnapshot(),b=s.body as any;b.destination.establishmentCode='0000';
  expect(validateProductionGuidesSnapshot(s)).toEqual(s);expect(buildProductionGuidesXml(s).xml).toContain('>0000</cbc:AddressTypeCode>');
 });
 it('does not widen internal04 and cannot attach third-party identity to an address',()=>{
  for(const side of ['origin','destination'] as const){const s=fuelSnapshot();delete(s.body as any)[side].establishmentCode;expect(()=>validateProductionGuidesSnapshot(s)).toThrow();}
  const s=fuelSnapshot();(s.body as any).origin.establishmentCode='0003';expect(()=>validateProductionGuidesSnapshot(s)).toThrow('GRE_ESTABLISHMENT_MISMATCH');
  for(const side of ['origin','destination'] as const){const s=purchaseSnapshot();(s.body as any)[side].ruc='20000000036';expect(()=>validateProductionGuidesSnapshot(s)).toThrow();}
 });
 it('keeps prior payloads exact and pins the full address rather than only ubigeos',async()=>{
  const s=purchaseSnapshot(),prior=structuredClone(s),c=purchaseCatalogue(s);expect(validateProductionGuidesSnapshot(s)).toEqual(prior);
  const changed=structuredClone(s);(changed.body as any).destination.address='ANOTHER SYNTHETIC DELIVERY';
  await expect(new ProductionGuidesCatalogueRules(c).validate(changed,{rulesSha256:hash(c)} as any)).rejects.toThrow('GRE_CATALOGUE_NOT_APPROVED');
  expect(s).toEqual(prior);
 });
});
