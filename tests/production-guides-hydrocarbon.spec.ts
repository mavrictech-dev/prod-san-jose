import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {snapshot09,snapshotPublic09} from './production-guides.fixture';
import {buildProductionGuidesXml,validateProductionGuidesSnapshot,HYDROCARBON_RULES,hydrocarbonRouteHash,productionGuidesHash as hash} from '../packages/sunat-core/src/production-guides';
import {ProductionGuidesCatalogueRules,type ProductionGuidesCatalogue} from '../services/sunat-service/src/production-guides-crypto';
import {validateOfficialGreXml} from '../services/sunat-service/src/production-guides-official-rules';
import {createGuideSidecarPki} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {signLocalGuideXml} from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import type {HydrocarbonFamily,HydrocarbonApproval} from '../packages/contracts/src/production-guides';
import {fuelSnapshot,fuelCatalogue} from './production-guides-hydrocarbon.fixture';
describe('ordinary hydrocarbon GRE, current official rules offline',()=>{
 it.each(['DIESEL','GASOHOL_PREMIUM','GASOHOL_REGULAR','GLP'] as const)('signs %s private04 and public01, validates actual latest XSL and XSD',async family=>{
  const xmls=[];
  for(const priv of [true,false]){
   const s=fuelSnapshot(family,priv),x=buildProductionGuidesXml(s),pki=createGuideSidecarPki(s.issuer.ruc);
   expect(validateProductionGuidesSnapshot(s).body).toMatchObject({regulatedGoods:true,hydrocarbon:{family}});
   expect(x.xml).toContain('>81</cbc:DocumentTypeCode>');expect(x.xml).toContain('schemeID="13"');
   const signed=signLocalGuideXml({issuerRuc:s.issuer.ruc,documentType:'09',fullNumber:x.fullNumber,unsignedXml:x.xml},pki.issuer.pkcs12,pki.password);
   await validateOfficialGreXml(signed.xml,`${s.issuer.ruc}-09-${x.fullNumber}.xml`);xmls.push(signed.xml);
  }
  const run=spawnSync('python',[fileURLToPath(new URL('./production-guides-xsd.py',import.meta.url))],{input:JSON.stringify({xmls}),encoding:'utf8',windowsHide:true,timeout:30000});expect(run.status,run.stderr).toBe(0);
 },60000);
 it('requires new classification, supported physical family and SCOP',()=>{
  for(const mutate of [(b:any)=>delete b.hydrocarbon,(b:any)=>b.regulatedGoods=false,(b:any)=>b.hydrocarbon.family='GNV',(b:any)=>b.hydrocarbon.scopCode='1',(b:any)=>b.hydrocarbon.senderRegistration='',(b:any)=>b.hydrocarbon.vehicleAuthorization=null]){const s=fuelSnapshot();mutate(s.body);expect(()=>validateProductionGuidesSnapshot(s)).toThrow();}
  const old=snapshot09();(old.body as any).regulatedGoods=true;expect(()=>validateProductionGuidesSnapshot(old)).toThrow();
 });
 it('binds the reviewed branch, entire route, family, registrations, current rules and validity',async()=>{
  const s=fuelSnapshot(),c=fuelCatalogue(s),g={rulesSha256:hash(c)} as any;await new ProductionGuidesCatalogueRules(c).validate(s,g);
  for(const mutate of [(a:any)=>a.branchId=s.documentId,(a:any)=>a.geography='SPECIAL_ZONE',(a:any)=>a.routeUbigeos.splice(1,0,'080907'),(a:any)=>a.routeUbigeos.splice(1,0,'170101'),(a:any)=>a.validUntil='2026-01-01',(a:any)=>a.routeUbigeos=['150102','150101'],(a:any)=>a.senderRegistration='OTHER-RH']){const next=structuredClone(c);mutate(next.hydrocarbonApprovals![0]);await expect(new ProductionGuidesCatalogueRules(next).validate(s,{rulesSha256:hash(next)} as any)).rejects.toThrow();}
  const bad=structuredClone(c);bad.goods[0].classification='NON_REGULATED';await expect(new ProductionGuidesCatalogueRules(bad).validate(s,{rulesSha256:hash(bad)} as any)).rejects.toThrow();
  const legacy=structuredClone(c);delete legacy.hydrocarbonApprovals;delete legacy.officialRules;legacy.goods[0].classification='NON_REGULATED';delete legacy.goods[0].family;await expect(new ProductionGuidesCatalogueRules(legacy).validate(s,{rulesSha256:hash(legacy)} as any)).rejects.toThrow();
  const old=snapshot09();(old.body as any).items=(s.body as any).items;legacy.goods[0].classification='NON_REGULATED';await expect(new ProductionGuidesCatalogueRules(legacy).validate(old,{rulesSha256:hash(legacy)} as any)).rejects.toThrow();
  await expect(new ProductionGuidesCatalogueRules(c,()=> '2027-01-02T00:00:00Z').validate(s,g)).rejects.toThrow('Vigencia');
 });
});
