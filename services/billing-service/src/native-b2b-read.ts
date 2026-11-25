import {BadRequestException,Injectable,NotFoundException} from '@nestjs/common';
import type {ProductionActor,ProductionScope} from '@factuez/service-access/dist/b2b-production-contract';
import {deny} from '@factuez/service-access/dist/b2b-production-contract';
import {PRODUCTION_GUIDES_PROFILES} from '@factuez/contracts/production-guides';
import {allowedTaxTreatment} from '@factuez/contracts';
import {PrismaService} from './infrastructure/prisma.service';
import {IssuanceQueryService} from './application/issuance-query.service';
import {CatalogTaxService} from './application/catalog-tax.service';
import {PrintBrandingService} from './application/print-branding.service';
import {NativeB2bBillingAuthority,type NativeBinding} from './native-b2b-authority';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export type NativeReadQuery={issuerRuc?:string;branchId?:string;pointId?:string;series?:string;after?:string;documentType?:string;q?:string;limit:number};
export function nativeReadQuery(value:unknown,extra:string[]=[]):NativeReadQuery {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([k,v])=>!['issuerRuc','branchId','pointId','series','after','limit','q',...extra].includes(k)||typeof v!=='string'))throw new BadRequestException('Revise los filtros: no se admiten parámetros repetidos o desconocidos.');
 const q=value as Record<string,string>;
 if(q.issuerRuc!==undefined&&!/^\d{11}$/.test(q.issuerRuc))throw new BadRequestException({code:'FIELD_VALIDATION_FAILED',fieldErrors:{issuerRuc:'El RUC debe tener exactamente 11 dígitos.'},message:'RUC de consulta inválido.'});
 for(const k of ['branchId','pointId'])if(q[k]!==undefined&&!uuid.test(q[k]))throw new BadRequestException({code:'FIELD_VALIDATION_FAILED',fieldErrors:{[k]:'Seleccione un identificador UUID válido del catálogo autorizado.'},message:'Sede o punto inválido.'});
 if(q.series!==undefined&&!/^[A-Z0-9]{4}$/.test(q.series)||q.q!==undefined&&(q.q.length>100||/[\x00-\x1f]/.test(q.q)))throw new BadRequestException('La serie o el texto de búsqueda no son válidos.');
 if(q.limit!==undefined&&!/^(?:[1-9]|[1-9]\d|100)$/.test(q.limit))throw new BadRequestException({code:'FIELD_VALIDATION_FAILED',fieldErrors:{limit:'Use un límite entero entre 1 y 100.'},message:'Límite de consulta inválido.'});
 return {...q,limit:Number(q.limit??50)};
}
export function filterNativeBindings(rows:NativeBinding[],q:{issuerRuc?:string;branchId?:string;pointId?:string;series?:string}){
 return rows.filter(n=>(!q.issuerRuc||q.issuerRuc===n.ruc)&&(!q.branchId||q.branchId===n.branchId)&&(!q.pointId||q.pointId===n.pointId)&&(!q.series||q.series===n.series));
}
const page=<T>(items:T[],limit:number,id:(item:T)=>string,after?:string,q?:string)=>{const sorted=[...items].filter(item=>!q||JSON.stringify(item).toLocaleLowerCase().includes(q.toLocaleLowerCase())).sort((a,b)=>id(a)<id(b)?-1:id(a)>id(b)?1:0).filter(row=>!after||id(row)>after),slice=sorted.slice(0,limit);return {items:slice,nextAfter:sorted.length>limit?id(slice[slice.length-1]):null};};
@Injectable()
export class NativeB2bReads {
 constructor(private readonly db:PrismaService,private readonly authority:NativeB2bBillingAuthority,private readonly query:IssuanceQueryService,private readonly taxes:CatalogTaxService,private readonly printing:PrintBrandingService){}
 private async rows(actor:ProductionActor,scope:ProductionScope,q:ReturnType<typeof nativeReadQuery>){const rows=filterNativeBindings(await this.authority.bindings(actor,scope),q);if(!rows.length)deny(403,'NATIVE_BINDING_DENIED');return rows;}
 async catalogue(actor:ProductionActor){return this.authority.serviceCatalogue(await this.authority.readAuthority(actor,'production:masters:read'));}
 async masters(kind:string,actor:ProductionActor,query:unknown){
  const q=nativeReadQuery(query,['documentType']),rows=await this.rows(actor,'production:masters:read',q);
  if(q.documentType!==undefined&&!['01','03','07','08','09','31'].includes(q.documentType))throw new BadRequestException('El tipo de documento debe ser 01, 03, 07, 08, 09 o 31.');
  if(kind==='issuers')return page([...new Map(rows.map(n=>[n.ruc,{id:n.companyId,ruc:n.ruc,legalName:n.legalName,tradeName:n.tradeName,environment:'PRODUCTION'}])).values()],q.limit,n=>n.ruc,q.after,q.q);
  if(kind==='branches')return page([...new Map(rows.map(n=>[n.branchId,{id:n.branchId,companyId:n.companyId,issuerRuc:n.ruc,code:n.branchCode,name:n.branchName}])).values()],q.limit,n=>n.id,q.after,q.q);
  if(kind==='points')return page([...new Map(rows.map(n=>[n.pointId,{id:n.pointId,companyId:n.companyId,issuerRuc:n.ruc,branchId:n.branchId,code:n.pointCode,name:n.pointName}])).values()],q.limit,n=>n.id,q.after,q.q);
  if(kind==='series')return page(rows.filter(n=>!q.documentType||n.documentType===q.documentType).map(n=>({id:n.seriesId,companyId:n.companyId,issuerRuc:n.ruc,branchId:n.branchId,pointId:n.pointId,series:n.series,documentType:n.documentType,nextNumber:n.nextNumber,numberReserved:false})),q.limit,n=>n.id,q.after,q.q);
  if(kind==='product-categories'){
   if(q.after&&!uuid.test(q.after))throw new BadRequestException('Cursor de categoría inválido.');
   const values=await this.db.productCategory.findMany({where:{active:true,...(q.after?{id:{gt:q.after}}:{})},select:{id:true,name:true,revision:true},orderBy:{id:'asc'},take:q.limit+1});
   return {items:values.slice(0,q.limit),nextAfter:values.length>q.limit?values[q.limit-1].id:null};
  }
  if(kind==='product-units'){
   if(q.after&&!/^[A-Z0-9]{2,3}$/.test(q.after))throw new BadRequestException('Cursor de unidad inválido.');
   const values=await this.db.productUnit.findMany({where:{active:true,...(q.after?{code:{gt:q.after}}:{})},select:{code:true,description:true,revision:true},orderBy:{code:'asc'},take:q.limit+1});
   return {items:values.slice(0,q.limit),nextAfter:values.length>q.limit?values[q.limit-1].code:null};
  }
  if(kind==='products'){
   if(!q.issuerRuc||!q.branchId)throw new BadRequestException({code:'FIELD_VALIDATION_FAILED',message:'Seleccione RUC y sede para obtener el IGV efectivo del producto.',fieldErrors:{issuerRuc:'Indique el RUC del catálogo de emisores.',branchId:'Indique la sede del catálogo de sedes.'}});
   if(q.after&&!uuid.test(q.after))throw new BadRequestException('Cursor de producto inválido.');
   const binding=rows[0],policy=await this.taxes.resolve(this.db,binding.companyId,binding.branchId),assignments=await this.taxes.assignments(this.db,binding.companyId,binding.branchId);
   const products=await this.db.fuelProduct.findMany({where:{active:true,unitMaster:{active:true},categoryMaster:{active:true},...(q.after?{id:{gt:q.after}}:{}),...(q.q?{OR:[{description:{contains:q.q,mode:'insensitive'}},{sku:{contains:q.q,mode:'insensitive'}}]}:{})},include:{categoryMaster:true,unitMaster:true},orderBy:{id:'asc'},take:q.limit+1});
   return {policy,items:products.slice(0,q.limit).map(p=>{const branch=assignments.find(a=>a.productId===p.id&&a.branchId===binding.branchId&&a.overridden),ruc=assignments.find(a=>a.productId===p.id&&a.branchId===null&&a.overridden),treatment=branch?.treatment??ruc?.treatment??policy.policy.defaultTreatment;return {id:p.id,sku:p.sku,description:p.description,category:{id:p.categoryId,name:p.categoryMaster?.name},unit:{code:p.unitCode,description:p.unitMaster?.description},defaultUnitPrice:p.defaultUnitPrice?.toString()??null,taxAffectationCode:treatment,igvRate:treatment==='10'?policy.policy.rate:'0.00',taxAllowed:allowedTaxTreatment(policy.policy,treatment),greGoodsFamily:p.greGoodsFamily};}),nextAfter:products.length>q.limit?products[q.limit-1].id:null};
  }
  deny(404,'ROUTE_NOT_FOUND');
 }
 reference(actor:ProductionActor){return {environment:'PRODUCTION',actorKind:actor.kind,documentTypes:[{code:'01',name:'Factura'},{code:'03',name:'Boleta'},{code:'07',name:'Nota de crédito'},{code:'08',name:'Nota de débito'},{code:'09',name:'Guía remitente'},{code:'31',name:'Guía transportista'}],taxTreatments:[{code:'10',name:'Gravado'},{code:'20',name:'Exonerado'},{code:'30',name:'Inafecto'}],guideProfiles:PRODUCTION_GUIDES_PROFILES,grants:actor.grants,creationMethod:'POST',getReservesNumber:false};}
 private where(rows:NativeBinding[]){return {OR:rows.map(n=>({companyId:n.companyId,emissionPointId:n.pointId,seriesCounterId:n.seriesId})),immutableSnapshot:{path:['environment'],equals:'PRODUCTION'}};}
 async documents(actor:ProductionActor,query:unknown){
  const q=nativeReadQuery(query),rows=await this.rows(actor,'production:documents:read',q);if(q.after&&!uuid.test(q.after))throw new BadRequestException('Cursor de comprobante inválido.');
  const values=await this.db.document.findMany({where:{...this.where(rows),...(q.after?{id:{gt:q.after}}:{}),...(q.q?{fullNumber:{contains:q.q,mode:'insensitive'}}:{})},select:{id:true,fullNumber:true,type:true,status:true,sunatStatus:true,issueDate:true,updatedAt:true,series:true,companyId:true,emissionPointId:true,seriesCounterId:true,customerIdentityType:true,customerIdentityNumber:true,customerLegalName:true,payableAmount:true},orderBy:{id:'asc'},take:q.limit+1});
  return {items:values.slice(0,q.limit).map(n=>({...n,payableAmount:n.payableAmount.toString()})),nextAfter:values.length>q.limit?values[q.limit-1].id:null};
 }
 async document(actor:ProductionActor,id:string){
  if(!uuid.test(id))throw new BadRequestException({code:'FIELD_VALIDATION_FAILED',message:'Documento inválido.',fieldErrors:{documentId:'Use un UUID del listado autorizado de documentos.'}});
  const value=await this.authority.readAuthority(actor,'production:documents:read');
  const own=await this.db.document.findFirst({where:{id,...this.where(value.bindings)},select:{id:true,companyId:true,emissionPointId:true,seriesCounterId:true,series:true,type:true,status:true,updatedAt:true,immutableSnapshot:true}});
  if(!own)throw new NotFoundException('Comprobante no disponible en el alcance de la aplicación.');
  const binding=value.bindings.find(n=>n.companyId===own.companyId&&n.pointId===own.emissionPointId&&n.seriesId===own.seriesCounterId)!;
  return {document:{...await this.query.documentDetail(value.scope,id),...own},binding,actorScope:value.scope};
 }
 async print(actor:ProductionActor,companyId:string,branchId:unknown){await this.authority.readAuthority(actor,'production:documents:read');return this.printing.snapshotForProductionService(companyId,branchId,actor);}
 async customers(actor:ProductionActor,query:unknown){
  const q=nativeReadQuery(query),rows=await this.rows(actor,'production:documents:read',q);
  let cursor:string[]|null=null;if(q.after){try{if(!/^[A-Za-z0-9_-]{1,200}$/.test(q.after))throw Error();const text=Buffer.from(q.after,'base64url').toString('utf8');cursor=JSON.parse(text);if(Buffer.from(text).toString('base64url')!==q.after||!Array.isArray(cursor)||cursor.length!==2||cursor.some((v,i)=>typeof v!=='string'||!v.length||v.length>(i===0?2:20)))throw Error();}catch{throw new BadRequestException('Cursor de cliente inválido.');}}
  const values=await this.db.$queryRawUnsafe<any[]>(`WITH visible AS (
   SELECT d.* FROM "Document" d JOIN jsonb_to_recordset($1::jsonb) AS g("companyId" integer,"pointId" text,"seriesId" text) ON d."companyId"=g."companyId" AND d."emissionPointId"=g."pointId"::uuid AND d."seriesCounterId"=g."seriesId"::uuid WHERE d."immutableSnapshot"->>'environment'='PRODUCTION'
  ), latest AS (SELECT DISTINCT ON ("customerIdentityType","customerIdentityNumber") "customerIdentityType" AS "identityType","customerIdentityNumber" AS "identityNumber","customerLegalName" AS "legalName","customerAddress" AS address,"customerEmail" AS email FROM visible ORDER BY "customerIdentityType","customerIdentityNumber","issueDate" DESC,id DESC)
  SELECT * FROM latest WHERE ($2::text IS NULL OR ("identityType","identityNumber")>($2,$3)) AND ($4::text IS NULL OR "legalName" ILIKE '%'||$4||'%' OR "identityNumber" ILIKE '%'||$4||'%') ORDER BY "identityType","identityNumber" LIMIT $5`,JSON.stringify(rows.map(n=>({companyId:n.companyId,pointId:n.pointId,seriesId:n.seriesId}))),cursor?.[0]??null,cursor?.[1]??null,q.q??null,q.limit+1);
  return {source:'DOCUMENT_HISTORY_IN_SCOPE',items:values.slice(0,q.limit),nextAfter:values.length>q.limit?Buffer.from(JSON.stringify([values[q.limit-1].identityType,values[q.limit-1].identityNumber])).toString('base64url'):null};
 }
}
