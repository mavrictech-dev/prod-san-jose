import {BadRequestException,ConflictException,Injectable,ServiceUnavailableException,Body,Controller,Get,Post,Param,Req,UseGuards} from '@nestjs/common';
import {HYDROCARBON_RULES,validateHydrocarbonApproval,hydrocarbonRouteHash,looksLikeFuel,productionGuidesHash} from '@factuez/sunat-core/dist/production-guides';
import {PrismaService} from './infrastructure/prisma.service';
import {FiscalConfigurationService} from './application/fiscal-configuration.service';
import {ConfigurationGuard,type ConfigurationRequest} from './auth/configuration.guard';
import type {ProductionGuidesCatalogue} from './production-guides-crypto';
export type GreCatalogueSource=(scope:{companyId:number;issuerRuc:string})=>Promise<{goods:{code:string;description:string;unitCode:string;greGoodsFamily?:string}[];branches?:{id:string;name:string;establishmentCode:string}[]}>;
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))throw new BadRequestException('Campos del catálogo GRE inválidos');}
function text(v:any,max=300){if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/u.test(v))throw new BadRequestException('Complete los datos del catálogo GRE sin caracteres de control');return v.trim();}
@Injectable()
export class ProductionGuidesCatalogueAdmin {
 constructor(private readonly db:PrismaService,private readonly fiscal:FiscalConfigurationService,private readonly source:GreCatalogueSource){}
 async status(companyId:string,authorization:string){const issuer=await this.fiscal.status(companyId,'PRODUCTION',authorization);return this.read(Number(companyId),issuer.ruc);}
 private async read(companyId:number,issuerRuc:string){
  const schema=(await this.db.$queryRawUnsafe<any[]>(`SELECT to_regclass('"ProductionGuidesCatalogue"') IS NOT NULL AS ready`))[0]?.ready;if(!schema)throw new ServiceUnavailableException('Migración del catálogo GRE pendiente: ejecute Update');
  const row=(await this.db.$queryRawUnsafe<any[]>('SELECT "revision","payload","createdAt" FROM "ProductionGuidesCatalogue" WHERE "issuerRuc"=$1 AND "companyId"=$2 ORDER BY "revision" DESC LIMIT 1',issuerRuc,companyId))[0];
  const source=await this.source({companyId,issuerRuc});return {companyId,issuerRuc,revision:row?.revision??0,catalogue:row?.payload??null,availableGoods:source.goods,reviewedAt:row?.createdAt??null};
 }
 async save(companyId:string,raw:unknown,authorization:string,actorId:string,existingTransaction?:any){
  const issuer=await this.fiscal.status(companyId,'PRODUCTION',authorization),v=raw as any;exact(v,['expectedRevision','sourceUrl','sourceSha256','reviewConfirmed','goodsCodes','routes','vehicles','drivers',...(Object.hasOwn(v??{},'hydrocarbonApprovals')?['hydrocarbonApprovals']:[])]);
  if(!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0||v.reviewConfirmed!==true||typeof v.sourceUrl!=='string'||!/^https:\/\/(?:cpe\.|www\.)?sunat\.gob\.pe\/[^\s?#]+$/.test(v.sourceUrl)||typeof v.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sourceSha256))throw new BadRequestException('Confirme la revisión, URL oficial y SHA-256 de la fuente de reglas usada');
  for(const key of ['goodsCodes','routes','vehicles','drivers'])if(!Array.isArray(v[key])||v[key].length>100)throw new BadRequestException('El catálogo admite hasta 100 registros por grupo');
  if(!v.goodsCodes.length||new Set(v.goodsCodes).size!==v.goodsCodes.length||!v.routes.length)throw new BadRequestException('Seleccione bienes únicos y al menos una ruta revisada');
  const available=await this.source({companyId:Number(companyId),issuerRuc:issuer.ruc});const goods=v.goodsCodes.map((code:unknown)=>{const g=available.goods.find(g=>g.code===code);if(!g)throw new BadRequestException('Bien o unidad inactivos/fuera del catálogo de productos');if(!g.greGoodsFamily||g.greGoodsFamily==='UNCLASSIFIED')throw new BadRequestException('Clasifique primero el producto en el maestro GRE');if(g.greGoodsFamily==='GNV')throw new BadRequestException('GNV: defina suministro en estación o transporte GNC/GNL antes de habilitar una guía');if(g.greGoodsFamily==='NON_REGULATED'&&looksLikeFuel(g))throw new BadRequestException('Un combustible no puede incorporarse como bien no regulado');return {...g,classification:g.greGoodsFamily==='NON_REGULATED'?'NON_REGULATED' as const:'HYDROCARBON' as const,family:g.greGoodsFamily as any};});
  const place=(p:any)=>{const keys=['ubigeo','address',...(Object.hasOwn(p??{},'establishmentCode')?['establishmentCode']:[])];exact(p,keys);if(typeof p.ubigeo!=='string'||!/^\d{6}$/.test(p.ubigeo)||p.ubigeo==='000000'||Object.hasOwn(p,'establishmentCode')&&(typeof p.establishmentCode!=='string'||!/^\d{4}$/.test(p.establishmentCode)))throw new BadRequestException('Ubigeo o establecimiento inválidos');return {ubigeo:p.ubigeo,address:text(p.address),...(p.establishmentCode!==undefined?{establishmentCode:p.establishmentCode}:{})};};
  const routes=v.routes.map((r:any)=>{exact(r,['origin','destination']);return {origin:place(r.origin),destination:place(r.destination)};});
  const vehicles=v.vehicles.map((r:any)=>{exact(r,['plate',...(Object.hasOwn(r??{},'registration')?['registration']:['tuc'])]);if(!/^[A-Z0-9]{6,8}$/.test(r.plate))throw new BadRequestException('Placa inválida');return {plate:r.plate,...(r.registration!==undefined?{registration:text(r.registration,30)}:{tuc:text(r.tuc,30)})};});
  const drivers=v.drivers.map((r:any)=>{exact(r,['identityType','identityNumber','firstName','lastName','license']);if(!['1','4'].includes(r.identityType)||typeof r.identityNumber!=='string'||!(r.identityType==='1'?/^\d{8}$/:/^[A-Z0-9]{1,12}$/).test(r.identityNumber))throw new BadRequestException('Documento del conductor inválido');return {identityType:r.identityType,identityNumber:r.identityNumber,firstName:text(r.firstName,100),lastName:text(r.lastName,100),license:text(r.license,30)};});
  let hydrocarbonApprovals:any[]=[];try{if(v.hydrocarbonApprovals!==undefined&&(!Array.isArray(v.hydrocarbonApprovals)||v.hydrocarbonApprovals.length>100))throw Error('Máximo 100 habilitaciones');hydrocarbonApprovals=(v.hydrocarbonApprovals??[]).map((raw:any)=>{const {routeIndex,...approval}=raw;if(routeIndex!==undefined){if(!Number.isSafeInteger(routeIndex)||!routes[routeIndex])throw Error('Ruta de habilitación inválida');approval.routeSha256=hydrocarbonRouteHash(routes[routeIndex]);}return validateHydrocarbonApproval(approval);});}catch(e){throw new BadRequestException(e instanceof Error?e.message:'Revisión de hidrocarburos inválida');}
  const catalogue:ProductionGuidesCatalogue={version:'factuez.production-guides.catalogue.v1',companyId:Number(companyId),issuerRuc:issuer.ruc,sourceUrl:v.sourceUrl,sourceSha256:v.sourceSha256,units:[...new Set<string>(goods.map((g:any)=>g.unitCode))],ubigeos:[...new Set<string>(routes.flatMap((r:any)=>[r.origin.ubigeo,r.destination.ubigeo]))],goods,routes,vehicles,drivers,...(hydrocarbonApprovals.length?{hydrocarbonApprovals,officialRules:HYDROCARBON_RULES}:{})};
  const persist=async(tx:any)=>{
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','native-gre-catalogue:'+issuer.ruc);
   const row=(await tx.$queryRawUnsafe('SELECT "revision" FROM "ProductionGuidesCatalogue" WHERE "issuerRuc"=$1 ORDER BY "revision" DESC LIMIT 1',issuer.ruc))[0];if((row?.revision??0)!==v.expectedRevision)throw new ConflictException('El catálogo GRE cambió; recargue antes de guardar');
   const current=await this.fiscal.status(companyId,'PRODUCTION',authorization);if(current.ruc!==issuer.ruc)throw new ConflictException('Cambió el emisor autorizado');
   await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesCatalogue" ("issuerRuc","revision","companyId","payload","payloadSha256","reviewedBy") VALUES ($1,$2,$3,$4::jsonb,$5,$6::uuid)',issuer.ruc,v.expectedRevision+1,Number(companyId),JSON.stringify(catalogue),productionGuidesHash(catalogue),actorId);
  };if(existingTransaction)await persist(existingTransaction);else await this.db.$transaction(persist,{timeout:15000});return existingTransaction?{companyId:Number(companyId),issuerRuc:issuer.ruc,revision:v.expectedRevision+1,catalogue}:this.read(Number(companyId),issuer.ruc);
 }
}
@Controller('api/v1/setup/sunat') @UseGuards(ConfigurationGuard)
export class ProductionGuidesCatalogueController {
 constructor(private readonly admin:ProductionGuidesCatalogueAdmin){}
 @Get(':companyId/PRODUCTION/guides/catalogue') get(@Param('companyId') id:string,@Req() r:ConfigurationRequest){return this.admin.status(id,r.headers.authorization!);}
 @Post(':companyId/PRODUCTION/guides/catalogue') save(@Param('companyId') id:string,@Body() body:unknown,@Req() r:ConfigurationRequest){return this.admin.save(id,body,r.headers.authorization!,r.user!.sub);}
}
