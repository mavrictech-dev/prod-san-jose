import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { allowsResource, DEFAULT_TAX_POLICY, NATURAL_REGIONS, PRODUCT_UNITS, allowedTaxTreatment, effectiveTax, validTaxRate, type TaxPolicy, type TaxPolicyView } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';
import type { AuthenticatedRequest } from '../auth/jwt-permission.guard';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateTaxPolicy(raw:unknown):TaxPolicy {
 const v=raw as TaxPolicy;
 if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='allowExempt,allowUnaffected,defaultTreatment,rate,regime,region,validFrom'||!NATURAL_REGIONS.some(r=>r.code===v.region)||!['GENERAL','CUSTOM'].includes(v.regime)||!validTaxRate(v.rate)||typeof v.allowExempt!=='boolean'||typeof v.allowUnaffected!=='boolean'||!allowedTaxTreatment(v,v.defaultTreatment)||!/^\d{4}-\d{2}-\d{2}$/.test(v.validFrom)||!Number.isFinite(Date.parse(v.validFrom))||new Date(v.validFrom).toISOString().slice(0,10)!==v.validFrom) throw new BadRequestException('Política inválida: revise región, tratamiento, tasa (%) y vigencia');
 if(v.regime==='GENERAL'&&Number(v.rate)!==18)throw new BadRequestException('El régimen general usa 18 %. Para otra tasa seleccione Personalizada; el perfil oficial puede rechazarla');
 return {...v,rate:Number(v.rate).toFixed(2)};
}
@Injectable()
export class CatalogTaxService {
 constructor(private readonly db:PrismaService){}
 private async ready(tx:any=this.db){const rows=await tx.$queryRawUnsafe(`SELECT to_regclass('"BillingTaxPolicy"') IS NOT NULL AND to_regclass('"ProductCategory"') IS NOT NULL AS ready`);if(!rows[0]?.ready)throw new ServiceUnavailableException('Actualización de catálogos y política tributaria pendiente: ejecute Update en la instalación');}
 private async scope(companyId:number,branchId:string|null,request:AuthenticatedRequest,write=false,tx:any=this.db){
  if(!Number.isSafeInteger(companyId)||companyId<1||branchId!==null&&!uuid.test(branchId))throw new BadRequestException('Seleccione emisor y sede válidos');
  const u=request.user;if(!u||!u.permissions.some(p=>['setup.manage','product.manage','document.issue','document.view'].includes(p)))throw new ForbiddenException();
  const company=await tx.companySettings.findUnique({where:{id:companyId}});if(!company)throw new NotFoundException('Emisor no disponible');
  if(branchId){const branch=await tx.branch.findFirst({where:{id:branchId,companyId}});if(!branch||!allowsResource(u.scope,branchId))throw new ForbiddenException('Sede fuera del alcance');}
  else if(u.scope.kind!=='GLOBAL'){const visible=await tx.branch.findFirst({where:{companyId,id:{in:u.scope.branchIds}}});if(!visible||write)throw new ForbiddenException('La política del RUC requiere alcance global; configure únicamente su sede autorizada');}
  if(write&&(!u.roles.includes('ADMIN')||!u.permissions.includes('setup.manage')))throw new ForbiddenException('Administración tributaria requiere administrador con permiso de configuración');
  return company;
 }
 private key(c:number,b:string|null){return b?'branch:'+b:'company:'+c;}
 async view(companyId:number,branchId:string|null,request:AuthenticatedRequest):Promise<TaxPolicyView>{await this.ready();await this.scope(companyId,branchId,request);return this.resolve(this.db,companyId,branchId);}
 async resolve(tx:any,companyId:number,branchId:string|null):Promise<TaxPolicyView>{
  const rows:any[]=await tx.$queryRawUnsafe('SELECT * FROM "BillingTaxPolicy" WHERE "companyId"=$1 AND ("branchId" IS NULL OR "branchId"=$2::uuid)',companyId,branchId);
  const ruc=rows.find(r=>r.branchId===null),branch=rows.find(r=>r.branchId===branchId&&branchId!==null),inherited=ruc?.overridden?ruc.policy:DEFAULT_TAX_POLICY,row=branchId?branch:ruc;
  return {companyId,branchId,revision:row?.revision??0,rucRevision:ruc?.revision??0,branchRevision:branch?.revision??0,overridden:row?.overridden??false,source:branch?.overridden?'BRANCH':ruc?.overridden?'RUC':'DEFAULT',policy:branch?.overridden?branch.policy:inherited,inherited:branchId?inherited:DEFAULT_TAX_POLICY};
 }
 async save(companyId:number,branchId:string|null,raw:unknown,request:AuthenticatedRequest){
  await this.ready();const v=raw as any;if(!v||Object.keys(v).some(k=>!['expectedRevision','overridden','policy'].includes(k))||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0||typeof v.overridden!=='boolean')throw new BadRequestException('Revisión y decisión de herencia requeridas');
  const policy=v.overridden?validateTaxPolicy(v.policy):DEFAULT_TAX_POLICY;
  return this.db.$transaction(async tx=>{
   await this.scope(companyId,branchId,request,true,tx);await tx.$queryRawUnsafe('SELECT id FROM "CompanySettings" WHERE id=$1 FOR UPDATE',companyId);await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','tax:'+companyId);
   const before=await this.resolve(tx,companyId,branchId);if(before.revision!==v.expectedRevision)throw new ConflictException('La política cambió. Recargue antes de guardar');
   await tx.$executeRawUnsafe('INSERT INTO "BillingTaxPolicy" ("scopeKey","companyId","branchId","revision","overridden","policy") VALUES ($1,$2,$3::uuid,$4,$5,$6::jsonb) ON CONFLICT ("scopeKey") DO UPDATE SET "revision"=EXCLUDED."revision","overridden"=EXCLUDED."overridden","policy"=EXCLUDED."policy","updatedAt"=now()',this.key(companyId,branchId),companyId,branchId,before.revision+1,v.overridden,JSON.stringify(policy));
   if(!branchId)await tx.companySettings.update({where:{id:companyId},data:{igvRate:policy.rate}});
   await tx.configurationAudit.create({data:{actorId:request.user!.sub,action:'tax-policy.updated',entityId:this.key(companyId,branchId),metadata:{before:JSON.parse(JSON.stringify(before)),after:{overridden:v.overridden,policy},historicalDocumentsChanged:false}}});
   return this.resolve(tx,companyId,branchId);
  });
 }
 async effectiveProducts(companyId:number,branchId:string|null,request:AuthenticatedRequest){
  await this.ready();await this.scope(companyId,branchId,request);const view=await this.resolve(this.db,companyId,branchId),assignments=await this.assignments(this.db,companyId,branchId);
  const products=await this.db.fuelProduct.findMany({where:{active:true,unitMaster:{active:true},categoryMaster:{active:true}},orderBy:{description:'asc'}});
  return {policy:view,products:products.map(p=>{const own=assignments.find(a=>a.productId===p.id&&a.branchId===branchId&&a.overridden),ruc=assignments.find(a=>a.productId===p.id&&a.branchId===null&&a.overridden),code=own?.treatment??ruc?.treatment??view.policy.defaultTreatment;return {...p,defaultUnitPrice:p.defaultUnitPrice?.toString()??null,taxAffectationCode:code,igvRate:code==='10'?view.policy.rate:'0',taxAllowed:allowedTaxTreatment(view.policy,code)};})};
 }
 async productTaxes(companyId:number,branchId:string|null,request:AuthenticatedRequest){await this.ready();await this.scope(companyId,branchId,request);return this.assignments(this.db,companyId,branchId);}
 async assignments(tx:any,companyId:number,branchId:string|null){return tx.$queryRawUnsafe('SELECT "productId","branchId","revision","overridden","treatment" FROM "BillingProductTax" WHERE "companyId"=$1 AND ("branchId" IS NULL OR "branchId"=$2::uuid)',companyId,branchId) as Promise<Array<{productId:string;branchId:string|null;revision:number;overridden:boolean;treatment:string}>>;}
 async saveProductTax(companyId:number,branchId:string|null,productId:string,raw:unknown,request:AuthenticatedRequest){
  await this.ready();const v=raw as any;if(!uuid.test(productId)||!v||Object.keys(v).sort().join(',')!=='expectedRevision,overridden,treatment'||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0||typeof v.overridden!=='boolean'||!['10','20','30'].includes(v.treatment))throw new BadRequestException('Afectación y revisión inválidas; 18 es un porcentaje, no un código de afectación');
  return this.db.$transaction(async tx=>{await this.scope(companyId,branchId,request,true,tx);await tx.$queryRawUnsafe('SELECT id FROM "CompanySettings" WHERE id=$1 FOR UPDATE',companyId);await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','tax:'+companyId);
   const p=await tx.fuelProduct.findUnique({where:{id:productId}});if(!p)throw new NotFoundException('Producto no disponible');
   const view=await this.resolve(tx,companyId,branchId);if(v.overridden&&!allowedTaxTreatment(view.policy,v.treatment))throw new BadRequestException('Habilite primero el tratamiento en la política tributaria de este RUC/sede');
   const rows=await this.assignments(tx,companyId,branchId),prior=rows.find(r=>r.branchId===branchId&&r.productId===productId);if((prior?.revision??0)!==v.expectedRevision)throw new ConflictException('La afectación cambió. Recargue antes de guardar');
   await tx.$executeRawUnsafe('INSERT INTO "BillingProductTax" ("scopeKey","companyId","branchId","productId","revision","overridden","treatment") VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7) ON CONFLICT ("scopeKey","productId") DO UPDATE SET "revision"=EXCLUDED."revision","overridden"=EXCLUDED."overridden","treatment"=EXCLUDED."treatment"',this.key(companyId,branchId),companyId,branchId,productId,v.expectedRevision+1,v.overridden,v.treatment);
   await tx.configurationAudit.create({data:{actorId:request.user!.sub,action:'product-tax.updated',entityId:productId,metadata:{companyId,branchId,revision:v.expectedRevision+1,overridden:v.overridden,treatment:v.treatment,historicalDocumentsChanged:false}}});return {revision:v.expectedRevision+1};
  });
 }
 async effectiveLines(tx:any,companyId:number,branchId:string,lines:Array<{productId?:string;unitCode?:string;taxAffectationCode:string;igvRate:string}>,issueDate:string,official:boolean){
  await this.ready(tx);await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','tax:'+companyId);
  const view=await this.resolve(tx,companyId,branchId),assignments=await this.assignments(tx,companyId,branchId);
  if(issueDate.slice(0,10)<view.policy.validFrom)throw new BadRequestException('La política aún no está vigente para la fecha de emisión');
  for(const line of lines){
   if(line.unitCode){await tx.$queryRawUnsafe('SELECT code FROM "ProductUnit" WHERE code=$1 FOR SHARE',line.unitCode);const unit=await tx.productUnit.findUnique({where:{code:line.unitCode}});if(!unit?.active)throw new BadRequestException('Unidad inactiva o fuera del catálogo validado');}
   let treatment=view.policy.defaultTreatment as string;
   if(line.productId){const p=await tx.fuelProduct.findUnique({where:{id:line.productId}});if(!p?.active)throw new BadRequestException('Producto inactivo o no disponible');
    if(line.unitCode&&p.unitCode!==line.unitCode)throw new ConflictException('La unidad del producto cambió. Recargue el producto antes de emitir');
    const category=p.categoryId?await tx.productCategory.findUnique({where:{id:p.categoryId}}):null;if(!category?.active)throw new BadRequestException('Categoría inactiva o pendiente de homologación');
    const branch=assignments.find(r=>r.productId===p.id&&r.branchId===branchId&&r.overridden),ruc=assignments.find(r=>r.productId===p.id&&r.branchId===null&&r.overridden);treatment=branch?.treatment??ruc?.treatment??view.policy.defaultTreatment;
   }
   if(!allowedTaxTreatment(view.policy,treatment))throw new BadRequestException('La afectación del producto ya no está habilitada por la política vigente');
   const expected=effectiveTax(view.policy,treatment);
   if(line.taxAffectationCode!==expected.taxAffectationCode||!validTaxRate(line.igvRate)&&line.igvRate!=='0'&&line.igvRate!=='0.00'||Number(line.igvRate)!==Number(expected.igvRate))throw new ConflictException('La política tributaria cambió. Recargue el producto: afectación y tasa (%) deben coincidir con el emisor/sede');
   if(official&&treatment==='10'&&Number(expected.igvRate)!==18)throw new BadRequestException('El perfil oficial instalado sólo admite gravado 10 al 18 %. Use el perfil local sintético para otros tratamientos; no se reservó correlativo');
  }
  return {companyId,branchId,revision:view.revision,rucRevision:view.rucRevision,branchRevision:view.branchRevision,source:view.source,policy:view.policy,assignments};
 }
 async masters(request:AuthenticatedRequest,kind:'categories'|'units'){await this.ready();if(!request.user?.permissions.some(p=>['product.manage','document.issue','document.view','setup.manage'].includes(p)))throw new ForbiddenException();return kind==='categories'?this.db.productCategory.findMany({orderBy:{name:'asc'}}):this.db.productUnit.findMany({orderBy:{code:'asc'}});}
 async saveMaster(kind:'categories'|'units',id:string|undefined,raw:unknown,request:AuthenticatedRequest){
  await this.ready();const actor=request.user;if(!actor||actor.scope.kind!=='GLOBAL'||!actor.roles.includes('ADMIN')||!actor.permissions.includes('product.manage'))throw new ForbiddenException('El catálogo compartido requiere administrador general con permiso de productos');
  const v=raw as any;if(!v||Object.keys(v).some(k=>!['name','description','active','expectedRevision'].includes(k))||id&&(!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<1)||v.active!==undefined&&typeof v.active!=='boolean')throw new BadRequestException('Campos o revisión del catálogo inválidos');
  if(kind==='units'&&(!id||!PRODUCT_UNITS.some(u=>u.code===id)))throw new BadRequestException('Unidad fuera del catálogo validado');
  if(kind==='categories'&&id&&!uuid.test(id))throw new BadRequestException('Categoría inválida');
  const text=kind==='categories'?v.name:v.description;if(typeof text!=='string'||!text.trim()||text.trim().length>(kind==='categories'?80:120)||/[\x00-\x1f\x7f]/u.test(text))throw new BadRequestException('Nombre o descripción inválidos');
  try{return await this.db.$transaction(async tx=>{
   const model:any=kind==='categories'?tx.productCategory:tx.productUnit,where=kind==='categories'?{id}:{code:id};
   const data=kind==='categories'?{name:text.trim().replace(/\s+/gu,' '),normalizedKey:text.trim().replace(/\s+/gu,' ').toLowerCase(),active:v.active??true}:{description:text.trim(),active:v.active??true};
   if(id){const changed=await model.updateMany({where:{...where,revision:v.expectedRevision},data:{...data,revision:{increment:1}}});if(!changed.count)throw new ConflictException('El catálogo cambió. Recargue antes de guardar');}
   const row=id?await model.findUnique({where}):await model.create({data});
   // Keep the legacy catalog projection consistent; immutable document snapshots
   // retain their original labels and are never rewritten by a master edit.
   if(kind==='categories'&&id)await tx.fuelProduct.updateMany({where:{categoryId:id},data:{category:row.name}});
   await tx.configurationAudit.create({data:{actorId:actor.sub,action:'product-'+kind+'.saved',entityId:row.id??row.code,metadata:{revision:row.revision,active:row.active}}});return row;
  });}catch(e){if((e as any).code==='P2002')throw new ConflictException('Ya existe una categoría equivalente. Selecciónela en el catálogo');throw e;}
 }
}
