import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {reviewGuideDeclarations} from '../packages/contracts/src/guide-declaration-review';
import {summarizeGuideFuelProfile,type GuideOperationalSettings} from '../packages/contracts/src/guide-operational-settings';
import {ProductionGuidesBillingController} from '../services/billing-service/src/production-guides.controller';
import {ProductionGuidesOwner} from '../services/billing-service/src/production-guides-owner';
import {fuelCatalogue,fuelSnapshot} from './production-guides-hydrocarbon.fixture';
import {validateProductionGuidesSnapshot} from '../packages/sunat-core/src/production-guides';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function draft():GuideOperationalSettings{
 const s=fuelSnapshot(),c=fuelCatalogue(s),location=(p:any)=>({...p,department:'SINTETICO',province:'SINTETICO',district:'SINTETICO'});
 return {role:'REMITENTE',products:[{id:uuid(1),commercialCode:c.goods[0].code,name:c.goods[0].description,type:'FUEL',unit:'GLL'}],routes:[{id:uuid(2),name:'RUTA SINTETICA',origin:location(c.routes[0].origin),destination:location(c.routes[0].destination)}],fuelProfile:{version:'factuez.guide-fuel-settings.v1',hydrocarbonRegistry:'RH-SYNTHETIC',products:[{productId:uuid(1),family:'DIESEL'}],routes:[{routeId:uuid(2),regime:'ORDINARY_GRE',transportMode:'02',reasonCode:'04',scop:'REQUIRED'}]}};
}
describe('declarations use the existing reviewed HYDROCARBON authority',()=>{
 it('matches exact product/route without manufacturing a grant or converting units',()=>{
  const d=draft(),before=structuredClone(d),review=reviewGuideDeclarations(d,fuelCatalogue());
  expect(review).toMatchObject({status:'MATCHED_REVIEWED_CATALOGUE',profiles:['GRE09_HYDROCARBON_PRIVATE04_V1'],fiscalTransmission:false});
  expect(review).not.toHaveProperty('grant');expect(d).toEqual(before);
 });
 it.each(['name','unit','code','family','route','catalogue','BF'] as const)('blocks unresolved %s rather than recategorizing fuel',kind=>{
  const d=draft();if(kind==='name')d.products[0].name+=' changed';if(kind==='unit')d.products[0].unit='LTR';if(kind==='code')d.products[0].commercialCode='OTHER';if(kind==='family')d.fuelProfile!.products[0].family='GLP';if(kind==='route')d.routes[0].origin.address+=' changed';if(kind==='BF')d.fuelProfile!.routes[0].regime='GRE_BF';
  expect(reviewGuideDeclarations(d,kind==='catalogue'?null:fuelCatalogue())).toMatchObject({status:'REVIEW_PENDING',fiscalTransmission:false});
 });
 it.each(['GASOHOL','GASOLINE','OTHER','PENDING_REVIEW'] as const)('keeps ambiguous family %s for external review',family=>{
  const d=draft();d.fuelProfile!.products[0].family=family;expect(summarizeGuideFuelProfile(d).status).toBe('INCOMPLETE');
 });
 it('does not offer a fuel 31 or the other branch fuel profiles',()=>{
  const d=draft();d.role='TRANSPORTISTA';Object.assign(d.fuelProfile!.routes[0],{transportMode:'01',reasonCode:'01'});
  expect(summarizeGuideFuelProfile(d)).toMatchObject({status:'INCOMPLETE',profiles:[]});
  for(const profile of ['GRE31_FUEL_PUBLIC_SINGLE09_V1','GRE09_FUEL_PRIVATE04_SCOP_V1','GRE09_FUEL_PUBLIC01_SCOP_V1'])expect(()=>validateProductionGuidesSnapshot({...fuelSnapshot(),profile})).toThrow();
 });
});
describe('human GRE grant administration requires current GLOBAL ADMIN scope',()=>{
 const user={sub:uuid(7),scope:{kind:'GLOBAL'},roles:['ADMIN'],permissions:['sunat.configure']};
 it.each(['assigned','not-admin','no-permission'] as const)('denies %s before calling the owner',kind=>{
  const configure=vi.fn(),createSeries=vi.fn(),controller=new ProductionGuidesBillingController({configure,createSeries} as any);
  const u={...user,...(kind==='assigned'?{scope:{kind:'ASSIGNED',branchIds:[],emissionPointIds:[],series:[]}}:kind==='not-admin'?{roles:['SUPERVISOR']}:{permissions:[]})};
  expect(()=>controller.grant(uuid(1),{}, {user:u} as any)).toThrow('administrador general');
  expect(()=>controller.createSeries({}, {user:u} as any)).toThrow('administrador general');expect(configure).not.toHaveBeenCalled();expect(createSeries).not.toHaveBeenCalled();
 });
 it('passes a global administrator to the append-only CAS owner',()=>{
  const configure=vi.fn(),controller=new ProductionGuidesBillingController({configure} as any),body={expectedVersion:5};controller.grant(uuid(1),body,{user} as any);
  expect(configure).toHaveBeenCalledWith(uuid(1),body,{userId:user.sub,scope:user.scope});
 });
 it('also rejects assigned scope at the owner command boundary',async()=>{
  const db={$transaction:vi.fn()},owner=new ProductionGuidesOwner(db as any,{enabled:()=>true} as any);
  await expect(owner.configure(uuid(1),{}, {userId:user.sub,scope:{kind:'ASSIGNED',branchIds:[],emissionPointIds:[],series:[]}})).rejects.toThrow('ADMIN_GLOBAL');expect(db.$transaction).not.toHaveBeenCalled();
 });
});
