import { describe,expect,it } from 'vitest';
import { validateGuideSettingsWrite,summarizeGuideFuelProfile } from '../packages/contracts/src/guide-operational-settings';
const productId='00000000-0000-4000-8000-000000000001',routeId='00000000-0000-4000-8000-000000000002';
function draft():any{
 const point={address:'DIRECCION SINTETICA',ubigeo:'150101',department:'Lima',province:'Lima',district:'Lima'};
 return {expectedRevision:0,settings:{role:'AMBOS',products:[{id:productId,name:'DIESEL B5 S50 SINTETICO',type:'FUEL',unit:'GLL'}],routes:[{id:routeId,name:'RUTA SINTETICA',origin:{...point,establishmentCode:'0001'},destination:{...point,address:'OTRO PUNTO',establishmentCode:'0002'}}],
 fuelProfile:{version:'factuez.guide-fuel-settings.v1',hydrocarbonRegistry:'REGISTRO-SINTETICO',products:[{productId,family:'DIESEL'}],routes:[{routeId,regime:'ORDINARY_GRE',transportMode:'01',reasonCode:'01',scop:'REQUIRED'}]}}};
}
describe('customer fuel settings are declarations, not fiscal authorization',()=>{
 it('round-trips a complete fuel profile with exact product/route references',()=>{
  const d=draft();expect(validateGuideSettingsWrite(d)).toEqual({ok:true,value:d});
  expect(summarizeGuideFuelProfile(d.settings)).toEqual({status:'READY_FOR_TECHNICAL_REVIEW',blockers:[],profiles:['GRE09_HYDROCARBON_PUBLIC01_V1'],fiscalTransmission:false});
 });
 it('keeps saved v1 declarations readable and flags missing fuel detail',()=>{
  const d=draft();delete d.settings.fuelProfile;expect(validateGuideSettingsWrite(d).ok).toBe(true);
  expect(summarizeGuideFuelProfile(d.settings)).toMatchObject({status:'INCOMPLETE',fiscalTransmission:false});
 });
 it.each(['grant','enabled','fiscalTransmission','certificate','scopCode','approvedBy'])('rejects supplied authority or operation-specific %s',key=>{
  const d=draft();d.settings.fuelProfile[key]='injected';expect(validateGuideSettingsWrite(d).ok).toBe(false);
 });
 it.each(['product','route','duplicate-product','duplicate-route','missing-product','missing-route','general-as-fuel','version','family','bidi','oversize'])('rejects malformed profile %s',kind=>{
  const d=draft(),f=d.settings.fuelProfile;
  if(kind==='product')f.products[0].productId=routeId;
  if(kind==='route')f.routes[0].routeId=productId;
  if(kind==='duplicate-product')f.products.push({...f.products[0]});
  if(kind==='duplicate-route')f.routes.push({...f.routes[0]});
  if(kind==='missing-product')f.products=[];
  if(kind==='missing-route')f.routes=[];
  if(kind==='general-as-fuel')d.settings.products[0].type='GENERAL';
  if(kind==='version')f.version='other';
  if(kind==='family')f.products[0].family='AUTO_APPROVED';
  if(kind==='bidi')f.hydrocarbonRegistry='x\u202ey';
  if(kind==='oversize')f.hydrocarbonRegistry='x'.repeat(61);
  expect(validateGuideSettingsWrite(d).ok).toBe(false);
 });
 it.each(['GRE_BF','PENDING_REVIEW'])('saves regime %s truthfully without treating it as emission-ready',regime=>{
  const d=draft();d.settings.fuelProfile.routes[0].regime=regime;
  expect(validateGuideSettingsWrite(d).ok).toBe(true);expect(summarizeGuideFuelProfile(d.settings)).toMatchObject({status:'INCOMPLETE',profiles:[],fiscalTransmission:false});
 });
 it('matches role, mode, reason and establishment scope without inventing transport data',()=>{
  const d=draft();d.settings.role='REMITENTE';expect(summarizeGuideFuelProfile(d.settings).profiles).toEqual(['GRE09_HYDROCARBON_PUBLIC01_V1']);
  d.settings.role='TRANSPORTISTA';expect(summarizeGuideFuelProfile(d.settings)).toMatchObject({profiles:[],status:'INCOMPLETE'});
  Object.assign(d.settings.fuelProfile.routes[0],{transportMode:'02',reasonCode:'04'});
  expect(summarizeGuideFuelProfile(d.settings).status).toBe('INCOMPLETE');
  d.settings.role='REMITENTE';expect(summarizeGuideFuelProfile(d.settings).profiles).toEqual(['GRE09_HYDROCARBON_PRIVATE04_V1']);
  d.settings.routes[0].destination.establishmentCode='0001';expect(summarizeGuideFuelProfile(d.settings).status).toBe('INCOMPLETE');
 });
 it.each(['scop','family','registry','unit','mode-reason','mixed-load','stale-routes'])('reports unresolved %s as incomplete',kind=>{
  const d=draft();
  if(kind==='scop')d.settings.fuelProfile.routes[0].scop='NOT_APPLICABLE';
  if(kind==='family')d.settings.fuelProfile.products[0].family='PENDING_REVIEW';
  if(kind==='registry')delete d.settings.fuelProfile.hydrocarbonRegistry;
  if(kind==='unit')d.settings.products[0].unit='KGM';
  if(kind==='mode-reason')d.settings.fuelProfile.routes[0].reasonCode='04';
  if(kind==='mixed-load')d.settings.products.push({...d.settings.products[0],id:'other',type:'GENERAL'});
  if(kind==='stale-routes')d.settings.fuelProfile.routes=[];
  expect(summarizeGuideFuelProfile(d.settings).status).toBe('INCOMPLETE');
 });
});
