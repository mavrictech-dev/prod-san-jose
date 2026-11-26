import {describe,it,expect} from 'vitest';
import {buildProductionGuidesXml,validateProductionGuidesSnapshot,productionGuidesHash as hash} from '../packages/sunat-core/src/production-guides';
import {ProductionGuidesCatalogueRules} from '../services/sunat-service/src/production-guides-crypto';
import {validateOfficialGreXml} from '../services/sunat-service/src/production-guides-official-rules';
import {signLocalGuideXml} from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import {createGuideSidecarPki} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {purchaseSnapshot,purchaseCatalogue} from './production-guides-purchase.fixture';
import {fuelSnapshot} from './production-guides-hydrocarbon.fixture';
import {safeXml} from '../services/sunat-service/src/infrastructure/sunat/safe-xml';
describe('ordinary purchase09/private02, multi-family v2',()=>{
 it('permits CDATA text only in the opted-in CDR parser, still refusing active or ambiguous markup',()=>{
  const xml='<ApplicationResponse><Description><![CDATA[SYNTHETIC TEXT]]></Description></ApplicationResponse>';
  expect(()=>safeXml(xml)).toThrow();expect(safeXml(xml,2048,true).textContent).toBe('SYNTHETIC TEXT');
  for(const unsafe of ['<!DOCTYPE x>','<!ENTITY x "x">','<!-- x -->','<?other instruction?>','<![CDATA[unterminated'])expect(()=>safeXml(unsafe+xml,2048,true)).toThrow();
 });
 it.each(['GLL','LTR'])('admits three exact fuel families in %s, independent SCOPs, buyer issuer and supplier origin through signed official XSD/XSL',async unit=>{
  const s=purchaseSnapshot(),b=s.body as any;for(const i of b.items)i.unitCode=unit;const c=purchaseCatalogue(s);expect(validateProductionGuidesSnapshot(s)).toEqual(s);
  await new ProductionGuidesCatalogueRules(c).validate(s,{rulesSha256:hash(c)} as any);
  const x=buildProductionGuidesXml(s),pki=createGuideSidecarPki(s.issuer.ruc),signed=signLocalGuideXml({issuerRuc:s.issuer.ruc,documentType:'09',fullNumber:x.fullNumber,unsignedXml:x.xml},pki.issuer.pkcs12,pki.password);
  expect(x.xml.match(/>81<\/cbc:DocumentTypeCode>/g)).toHaveLength(2);expect(x.xml).toContain('>Compra</cbc:HandlingInstructions>');expect(x.xml).toContain('<cac:SellerSupplierParty>');expect(x.xml).toContain(`listID="${b.supplier.ruc}"`);
  expect(x.xml).toContain(`listID="${s.issuer.ruc}"`);await validateOfficialGreXml(signed.xml,`${s.issuer.ruc}-09-${x.fullNumber}.xml`);
 },60000);
 it.each(['supplier-self','supplier-missing','recipient-other','origin-buyer','reason04','public','BJ','zero','duplicate','missing-scop','extra-scop','GLP','v1'] as const)('blocks %s without relabelling or conversions',kind=>{
  const s=purchaseSnapshot(),b=s.body as any;
  if(kind==='supplier-self')b.supplier=s.issuer;if(kind==='supplier-missing')delete b.supplier;if(kind==='recipient-other')b.recipient=b.supplier;if(kind==='origin-buyer')b.origin={...b.destination};if(kind==='reason04')b.reasonCode='04';if(kind==='public')b.transport.mode='01';if(kind==='BJ')b.items[0].unitCode='BJ';if(kind==='zero')b.items[0].quantity='0';if(kind==='duplicate')b.hydrocarbon.items[1].code=b.hydrocarbon.items[0].code;if(kind==='missing-scop')b.hydrocarbon.items[0].scopCode=null;if(kind==='extra-scop')b.hydrocarbon.items[0].code='FOREIGN';if(kind==='GLP')b.hydrocarbon.items[0].family='GLP';if(kind==='v1')b.hydrocarbon=(fuelSnapshot().body as any).hydrocarbon;
  expect(()=>validateProductionGuidesSnapshot(s)).toThrow();
 });
 it.each(['approval-missing','supplier','family','territory','expired','route','master-family','catalogue-pin'] as const)('requires current approvals for every family: %s',async kind=>{
  const s=purchaseSnapshot(),c=purchaseCatalogue(s);if(kind==='approval-missing')c.hydrocarbonApprovals!.pop();if(kind==='supplier')(c.hydrocarbonApprovals![0] as any).supplier.legalName='OTHER';if(kind==='family')c.hydrocarbonApprovals![0].family='GASOHOL_REGULAR';if(kind==='territory')c.hydrocarbonApprovals![0].routeUbigeos.splice(1,0,'170101');if(kind==='expired')c.hydrocarbonApprovals![0].validUntil='2020-01-01';if(kind==='route')c.hydrocarbonApprovals![0].routeSha256='c'.repeat(64);if(kind==='master-family')c.goods[0].family='GASOHOL_PREMIUM';
  await expect(new ProductionGuidesCatalogueRules(c).validate(s,{rulesSha256:kind==='catalogue-pin'?'c'.repeat(64):hash(c)} as any)).rejects.toThrow();
 });
 it('does not widen existing v1 profiles',()=>{const old=fuelSnapshot();(old.body as any).reasonCode='02';expect(()=>validateProductionGuidesSnapshot(old)).toThrow();const s=purchaseSnapshot();s.profile='GRE09_HYDROCARBON_PRIVATE04_V1';expect(()=>validateProductionGuidesSnapshot(s)).toThrow();});
});
