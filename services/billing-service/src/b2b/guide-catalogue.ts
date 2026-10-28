import {Body,Controller,Inject,Module,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {validB2bGuideBinding,b2bGuideBindingKey,type B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {PrismaService} from '../infrastructure/prisma.service';
import {B2bContextFilter} from './http';
export interface GuideCatalogue{resolve(binding:B2bGuideBinding):Promise<{binding:B2bGuideBinding;seriesLabel:string;metadataSha256:string}|null>}
/** Explicit metadata slots for draft planning, never fiscal numbering. No seeds,
 * implicit 31 enum mapping, runtime migration, credential or SUNAT access. */
export class PrismaGuideDraftCatalogue implements GuideCatalogue {
  constructor(private readonly db:PrismaService){}
  async resolve(binding:B2bGuideBinding){
    if(!validB2bGuideBinding(binding))return null;const a=binding.anchor;
    const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT g."id",g."companyId",g."pointId",g."guideType",g."label",g."revision",g."purpose",
      c."ruc",c."environment",p."branchId",p."code" AS "pointCode",s."id" AS "anchorSeriesId",s."series" AS "anchorLabel",s."documentType"
      FROM "B2bGuideDraftSeries" g JOIN "CompanySettings" c ON c."id"=g."companyId" AND c."active"=true AND c."environment"='BETA'
      JOIN "EmissionPoint" p ON p."id"=g."pointId" AND p."companyId"=c."id" AND p."active"=true
      JOIN "Branch" b ON b."id"=p."branchId" AND b."companyId"=c."id" AND b."active"=true
      JOIN "SeriesCounter" s ON s."id"=$2::uuid AND s."companyId"=c."id" AND s."emissionPointId"=p."id" AND s."active"=true
      WHERE g."id"=$1::uuid AND g."active"=true AND g."purpose"='DRAFT_ONLY' AND g."companyId"=$3 AND c."ruc"=$4
      AND p."branchId"=$5::uuid AND p."id"=$6::uuid AND g."guideType"=$7`,binding.guideSeriesId,a.seriesId,a.issuerId,a.issuerRuc,a.branchId,a.pointId,binding.guideType);
    const row=rows[0];if(rows.length!==1||row.documentType!==(a.documentType==='01'?'INVOICE':'SALES_RECEIPT'))return null;
    return{binding:structuredClone(binding),seriesLabel:row.label as string,metadataSha256:fiscalSnapshotSha256(row)};
  }
  async validate(value:unknown){
    let v:unknown;try{v=boundedSupplementJson(value);}catch{throw new B2bSecurityError(400,'INVALID_GUIDE_BINDINGS');}
    if(!Array.isArray(v)||!v.length||v.length>500||!v.every(validB2bGuideBinding)||new Set(v.map(b2bGuideBindingKey)).size!==v.length)throw new B2bSecurityError(400,'INVALID_GUIDE_BINDINGS');
    for(const b of v)if(!await this.resolve(b))throw new B2bSecurityError(400,'INVALID_GUIDE_BINDINGS');return{valid:true};
  }
}
const CORE=Symbol('Guide draft catalogue'),PEERS=Symbol('Guide catalogue registrar peers');
@Controller('internal/b2b')
@UseFilters(B2bContextFilter)
export class BillingGuideCatalogueController{
  constructor(@Inject(CORE)private readonly core:PrismaGuideDraftCatalogue,@Inject(PEERS)private readonly peers:readonly string[]){}
  @Post('validate-guide-bindings')async validate(@Req()req:any,@Res()res:any,@Body()value:unknown){
    b2bPrivatePeer(req,this.peers);res.setHeader('Cache-Control','private, no-store');
    let body:Record<string,unknown>;try{body=boundedSupplementJson(value) as Record<string,unknown>;}catch{throw new B2bSecurityError(400,'INVALID_REQUEST');}
    if(!body||Object.keys(body).join(',')!=='bindings')throw new B2bSecurityError(400,'INVALID_REQUEST');res.status(200).json(await this.core.validate(body.bindings));
  }
}
@Module({})
export class BillingGuideCatalogueModule{
  static isolated(core:PrismaGuideDraftCatalogue,peers:string[]):DynamicModule{
    if(!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit guide catalogue peers required');
    return{module:BillingGuideCatalogueModule,controllers:[BillingGuideCatalogueController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])},B2bContextFilter]};
  }
}
