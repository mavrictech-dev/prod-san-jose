/** Customer declarations only: this contract never authorizes fiscal transmission. */
export const GUIDE_OPERATIONAL_SETTINGS_VERSION = 'factuez.guide-operational-settings.v1' as const;
export const GUIDE_SETTINGS_MAX_BYTES = 131072;
export const GUIDE_ROLES = ['REMITENTE', 'TRANSPORTISTA', 'AMBOS'] as const;
export const GUIDE_PRODUCT_TYPES = ['FUEL', 'OTHER_REGULATED', 'GENERAL'] as const;
export const GUIDE_UNITS = ['LTR', 'GLL', 'KGM', 'TNE', 'NIU'] as const;
export type GuideRole = typeof GUIDE_ROLES[number];
export type GuideProduct = { id: string; name: string; type: typeof GUIDE_PRODUCT_TYPES[number]; unit: typeof GUIDE_UNITS[number]; commercialCode?: string };
export type GuideLocation = { address: string; ubigeo: string; department: string; province: string; district: string; establishmentCode?: string };
export type GuideRoute = { id: string; name: string; origin: GuideLocation; destination: GuideLocation };
export const GUIDE_FUEL_FAMILIES = ['PENDING_REVIEW','DIESEL','GASOHOL','GASOHOL_PREMIUM','GASOHOL_REGULAR','GASOLINE','GLP','OTHER'] as const;
export type GuideFuelRoute = { routeId: string; regime: 'PENDING_REVIEW'|'ORDINARY_GRE'|'GRE_BF'; transportMode: '01'|'02'; reasonCode: '01'|'02'|'04'; scop: 'PENDING_REVIEW'|'REQUIRED'|'NOT_APPLICABLE' };
export type GuideFuelSettings = { version: 'factuez.guide-fuel-settings.v1'; hydrocarbonRegistry?: string; products: { productId: string; family: typeof GUIDE_FUEL_FAMILIES[number] }[]; routes: GuideFuelRoute[] };
export type GuideOperationalSettings = { role: GuideRole; products: GuideProduct[]; routes: GuideRoute[]; fuelProfile?: GuideFuelSettings };
export type GuideSettingsWrite = { expectedRevision: number; settings: GuideOperationalSettings };
export type GuideSettingsDocument = {
  version: typeof GUIDE_OPERATIONAL_SETTINGS_VERSION; companyId: number; ruc: string; revision: number;
  settings: GuideOperationalSettings | null; updatedAt: string | null; updatedBy: string | null;
  status: 'NOT_CONFIGURED' | 'PROFILE_REVIEW_PENDING'; configured: boolean; fiscalTransmission: false;
};
export type GuideSettingsIssue = { path: string; message: string };
export type GuideSettingsValidation = { ok: true; value: GuideSettingsWrite } | { ok: false; issues: GuideSettingsIssue[] };

/** Shared, browser-safe strict validation. Locations are declared, not officially verified. */
export function validateGuideSettingsWrite(input: unknown): GuideSettingsValidation {
  const issues: GuideSettingsIssue[] = [];
  const issue = (path: string, message: string) => { issues.push({ path, message }); };
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).length > GUIDE_SETTINGS_MAX_BYTES) return { ok: false, issues: [{ path: '', message: 'La configuración supera el tamaño permitido (128 KiB).' }] };
  } catch { return { ok: false, issues: [{ path: '', message: 'Configuración inválida.' }] }; }
  function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issue(path, 'Complete los campos requeridos.'); return {}; }
    if (Object.keys(value).some(key => !keys.includes(key))) issue(path, 'Hay campos no admitidos.');
    return value as Record<string, unknown>;
  }
  function text(value: unknown, path: string, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}<>]/u.test(value)) { issue(path, `Ingrese entre 1 y ${max} caracteres sin controles ni etiquetas.`); return ''; }
    return value.trim();
  }
  function choice<T extends string>(value: unknown, path: string, values: readonly T[]): T {
    if (!values.includes(value as T)) issue(path, 'Seleccione una opción válida.');
    return value as T;
  }
  const ids = new Set<string>();
  function id(value: unknown, path: string): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) { issue(path, 'Identificador inválido.'); return ''; }
    const result = value.toLowerCase();
    if (ids.has(result)) issue(path, 'Identificador duplicado.');
    ids.add(result); return result;
  }
  function list(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 30) { issue(path, 'Agregue entre 1 y 30 entradas completas.'); return []; }
    return value;
  }
  function unique(values: string[], path: string) {
    const normalized = values.filter(Boolean).map(value => value.normalize('NFKC').toLocaleLowerCase('es'));
    if (new Set(normalized).size !== normalized.length) issue(path, 'Hay entradas duplicadas. Use nombres y códigos diferentes.');
  }
  function location(value: unknown, path: string): GuideLocation {
    const obj = object(value, path, ['address', 'ubigeo', 'department', 'province', 'district', 'establishmentCode']);
    const result: GuideLocation = { address: text(obj.address, `${path}.address`, 300), ubigeo: '', department: text(obj.department, `${path}.department`, 100), province: text(obj.province, `${path}.province`, 100), district: text(obj.district, `${path}.district`, 100) };
    if (typeof obj.ubigeo !== 'string' || !/^\d{6}$/.test(obj.ubigeo)) issue(`${path}.ubigeo`, 'Use exactamente seis dígitos.');
    else result.ubigeo = obj.ubigeo;
    if (obj.establishmentCode !== undefined) {
      if (typeof obj.establishmentCode !== 'string' || !/^\d{4}$/.test(obj.establishmentCode)) issue(`${path}.establishmentCode`, 'Use exactamente cuatro dígitos o deje vacío.');
      else result.establishmentCode = obj.establishmentCode;
    }
    return result;
  }
  const body = object(input, '', ['expectedRevision', 'settings']);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Number(body.expectedRevision) >= 2147483647) issue('expectedRevision', 'Recargue la configuración vigente.');
  const settings = object(body.settings, 'settings', ['role', 'products', 'routes', 'fuelProfile']);
  const role = choice(settings.role, 'settings.role', GUIDE_ROLES);
  const products = list(settings.products, 'settings.products').map((value, index): GuideProduct => {
    const path = `settings.products.${index}`, obj = object(value, path, ['id', 'name', 'type', 'unit', 'commercialCode']);
    const result: GuideProduct = { id: id(obj.id, `${path}.id`), name: text(obj.name, `${path}.name`, 160), type: choice(obj.type, `${path}.type`, GUIDE_PRODUCT_TYPES), unit: choice(obj.unit, `${path}.unit`, GUIDE_UNITS) };
    if (obj.commercialCode !== undefined) result.commercialCode = text(obj.commercialCode, `${path}.commercialCode`, 80);
    return result;
  });
  const routes = list(settings.routes, 'settings.routes').map((value, index): GuideRoute => {
    const path = `settings.routes.${index}`, obj = object(value, path, ['id', 'name', 'origin', 'destination']);
    return { id: id(obj.id, `${path}.id`), name: text(obj.name, `${path}.name`, 160), origin: location(obj.origin, `${path}.origin`), destination: location(obj.destination, `${path}.destination`) };
  });
  let fuelProfile: GuideFuelSettings | undefined;
  if (settings.fuelProfile !== undefined) {
    const path='settings.fuelProfile';
    const f=object(settings.fuelProfile,path,['version','hydrocarbonRegistry','products','routes']);
    if(f.version!=='factuez.guide-fuel-settings.v1')issue(`${path}.version`,'Versión del perfil de combustibles inválida.');
    fuelProfile={version:'factuez.guide-fuel-settings.v1',products:[],routes:[]};
    if(f.hydrocarbonRegistry!==undefined)fuelProfile.hydrocarbonRegistry=text(f.hydrocarbonRegistry,`${path}.hydrocarbonRegistry`,60);
    const references=(value:unknown,expected:string[],key:string,allowed:string[],parse:(v:Record<string,unknown>,p:string)=>void)=>{
      const entries=list(value,`${path}.${key}`),seen=new Set<string>();
      for(const [index,entry] of entries.entries()){
        const p=`${path}.${key}.${index}`,obj=object(entry,p,allowed),ref=obj[allowed[0]];
        if(typeof ref!=='string'||!expected.includes(ref)||seen.has(ref))issue(p,'Referencia duplicada o ajena a los productos y rutas configurados.');
        else seen.add(ref);
        parse(obj,p);
      }
      if(seen.size!==expected.length)issue(`${path}.${key}`,'Complete todos los productos de combustible y todas las rutas.');
    };
    references(f.products,products.filter(p=>p.type==='FUEL').map(p=>p.id),'products',['productId','family'],(obj,p)=>{
      fuelProfile!.products.push({productId:obj.productId as string,family:choice(obj.family,`${p}.family`,GUIDE_FUEL_FAMILIES)});
    });
    references(f.routes,routes.map(r=>r.id),'routes',['routeId','regime','transportMode','reasonCode','scop'],(obj,p)=>{
      fuelProfile!.routes.push({routeId:obj.routeId as string,regime:choice(obj.regime,`${p}.regime`,['PENDING_REVIEW','ORDINARY_GRE','GRE_BF'] as const),
        transportMode:choice(obj.transportMode,`${p}.transportMode`,['01','02'] as const),reasonCode:choice(obj.reasonCode,`${p}.reasonCode`,['01','02','04'] as const),scop:choice(obj.scop,`${p}.scop`,['PENDING_REVIEW','REQUIRED','NOT_APPLICABLE'] as const)});
    });
  }
  unique(products.map(p => p.name), 'settings.products'); unique(products.map(p => p.commercialCode ?? ''), 'settings.products'); unique(routes.map(r => r.name), 'settings.routes');
  return issues.length ? { ok: false, issues } : { ok: true, value: { expectedRevision: body.expectedRevision as number, settings: { role, products, routes, ...(fuelProfile ? {fuelProfile} : {}) } } };
}

/** Declaration completeness only. Server grants, catalogues and cryptographic checks remain separate. */
export function summarizeGuideFuelProfile(settings: GuideOperationalSettings) {
  const fuel=settings.products.filter(p=>p.type==='FUEL'),profile=settings.fuelProfile;
  const blockers:string[]=[];
  if(!fuel.length)return {status:'NOT_APPLICABLE' as const,blockers,profiles:[] as string[],fiscalTransmission:false as const};
  if(!profile)return {status:'INCOMPLETE' as const,blockers:['Complete la pestaña Combustibles.'],profiles:[] as string[],fiscalTransmission:false as const};
  if(!profile.hydrocarbonRegistry)blockers.push('Declare el registro de hidrocarburos del emisor.');
  if(settings.products.some(p=>p.type!=='FUEL'))blockers.push('El perfil disponible contempla cargas de combustible sin mezcla de otros bienes.');
  if(fuel.some(p=>!['LTR','GLL',...(profile.products.find(f=>f.productId===p.id)?.family==='GLP'?['KGM','TNE']:[])].includes(p.unit)))blockers.push('La unidad debe corresponder al producto revisado: LTR/GLL, o KGM/TNE para GLP; no se convierten cantidades ni se infiere densidad.');
  if(profile.products.length!==fuel.length||fuel.some(p=>!profile.products.some(f=>f.productId===p.id&&['DIESEL','GASOHOL_PREMIUM','GASOHOL_REGULAR','GLP'].includes(f.family))))blockers.push('Complete la familia de cada combustible; actualice los productos y las rutas del perfil si cambiaron.');
  if(profile.routes.length!==settings.routes.length)blockers.push('Actualice las rutas del perfil de combustibles.');
  const profiles=new Set<string>();
  for(const r of settings.routes){
    const p=profile.routes.find(p=>p.routeId===r.id);
    if(!p||p.regime==='PENDING_REVIEW'){blockers.push(`${r.name}: defina si corresponde GRE ordinaria o GRE de bienes fiscalizados.`);continue;}
    if(p.regime==='GRE_BF'){blockers.push(`${r.name}: requiere el sistema GRE de bienes fiscalizados de SUNAT; fuera del envío GRE ordinario de este perfil.`);continue;}
    if(p.scop!=='REQUIRED'){blockers.push(`${r.name}: el perfil disponible requiere SCOP en cada traslado.`);continue;}
    if(p.transportMode==='02'&&p.reasonCode==='02'){
      if(!r.origin.establishmentCode||!r.destination.establishmentCode){blockers.push(`${r.name}: declare establecimiento del proveedor en origen y del comprador en llegada.`);continue;}
      if(profile.products.some(f=>!['DIESEL','GASOHOL_REGULAR','GASOHOL_PREMIUM'].includes(f.family))){blockers.push(`${r.name}: Compra privada sólo admite diésel y gasoholes; GLP/GNV requieren otro perfil revisado.`);continue;}
      if(settings.role!=='TRANSPORTISTA')profiles.add('GRE09_HYDROCARBON_PRIVATE02_V1');
      else blockers.push(`${r.name}: Compra privada requiere emitir como comprador/remitente.`);
    }else if(p.transportMode==='02'&&p.reasonCode==='04'){
      if(!r.origin.establishmentCode||!r.destination.establishmentCode||r.origin.establishmentCode===r.destination.establishmentCode){blockers.push(`${r.name}: declare establecimientos SUNAT diferentes para el traslado interno.`);continue;}
      if(settings.role!=='TRANSPORTISTA')profiles.add('GRE09_HYDROCARBON_PRIVATE04_V1');
      else blockers.push(`${r.name}: transporte privado entre establecimientos requiere emitir como remitente.`);
    }else if(p.transportMode==='01'&&p.reasonCode==='01'){
      if(settings.role!=='TRANSPORTISTA')profiles.add('GRE09_HYDROCARBON_PUBLIC01_V1');
      if(settings.role==='TRANSPORTISTA')blockers.push(`${r.name}: GRE 31 de combustible no habilitada; requiere controles equivalentes revisados.`);
    }else blockers.push(`${r.name}: seleccione venta pública, compra privada o traslado interno privado.`);
  }
  return {status:blockers.length?'INCOMPLETE' as const:'READY_FOR_TECHNICAL_REVIEW' as const,blockers,profiles:[...profiles],fiscalTransmission:false as const};
}
