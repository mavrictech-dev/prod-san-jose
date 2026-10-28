import type { FiscalDocumentSnapshot,FrozenPrintPresentationV1 } from '@factuez/contracts';
import { B2bSecurityError,b2bBindingsContain,validB2bBinding,type B2bBinding,type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bDocumentFilters,b2bIssuerId,b2bQuery,b2bUuid,type B2bDocumentFilters } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import { BillingRead,mapBillingDocument,type BillingReadRepository } from '../integration/read';
import type { PrismaService } from '../infrastructure/prisma.service';
import { PrismaBillingRead } from '../integration/repository';
import { PrismaB2bContextRepository } from './context';
import type { B2bBillingExtraction } from './extraction';
export interface B2bBillingReadRepository extends BillingReadRepository {
  contexts(bindings:B2bBinding[]):Promise<any[]>;
  capture(filters:B2bDocumentFilters,bindings:B2bBinding[]):Promise<any[]>;
  products():Promise<unknown[]>;
}
export interface B2bPrintProfiles {snapshotForB2b(binding:B2bBinding,p:B2bPrincipal):Promise<FrozenPrintPresentationV1|undefined>}
export class B2bBillingReads {
  constructor(private readonly repository:B2bBillingReadRepository,private readonly identity:B2bIdentityPort,private readonly printing:B2bPrintProfiles|null=null,private readonly extraction:B2bBillingExtraction|null=null){}
  async execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){
    if(typeof action==='string'&&action.startsWith('extract:')){if(!this.extraction)throw new B2bSecurityError(503,'EXTRACTION_NOT_CONFIGURED');return this.extraction.execute(token,kind,action,args);}
    const frame=new B2bOwnerReadFrame(this.identity,kind);
    if(action==='catalog'||action==='products'){
      b2bQuery(args,['environment'],['environment']);
      const principal=await frame.principal(token,['b2b:catalog:read']);
      const items=action==='catalog'?await this.repository.contexts(principal.bindings):await this.repository.products();
      if(items.length>10000||Buffer.byteLength(JSON.stringify(items))>16*1024*1024)throw new B2bSecurityError(413,'NARROW_QUERY');
      await frame.principal(token,['b2b:catalog:read']);return {items};
    }
    if(action==='capture'){
      const filters=b2bDocumentFilters(args),principal=await frame.principal(token,['b2b:documents:read']);
      const selected=principal.bindings.filter(binding=>binding.issuerId===filters.issuerId&&filters.types.includes(binding.documentType)&&
        (!filters.branchId||binding.branchId===filters.branchId)&&(!filters.pointId||binding.pointId===filters.pointId)&&(!filters.seriesId||binding.seriesId===filters.seriesId));
      if(!selected.length)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
      const rows=await this.repository.capture(filters,selected);if(rows.length>10000)throw new B2bSecurityError(413,'NARROW_QUERY');
      const projection=await frame.authenticate(token,['integration:documents:read']);
      const items=rows.map(row=>this.documentProjection(row,principal,projection));
      if(Buffer.byteLength(JSON.stringify(items))>16*1024*1024)throw new B2bSecurityError(413,'NARROW_QUERY');
      await frame.principal(token,['b2b:documents:read']);return {items,capturedAt:new Date().toISOString(),filters};
    }
    if(!['document','lookup','batch','print-snapshot'].includes(action))throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
    const q=b2bQuery(args,action==='lookup'?['issuerId','environment','type','series','number']:['issuerId','environment','id'],action==='lookup'?['issuerId','environment','type','series','number']:['issuerId','environment','id']);
    const issuerId=b2bIssuerId(q.issuerId),principal=await frame.principal(token,action==='print-snapshot'?['b2b:documents:read','b2b:artifacts:read']:['b2b:documents:read']);
    const allowed=principal.bindings.filter(binding=>binding.issuerId===issuerId);
    if(!allowed.length)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    if(new Set(allowed.map(binding=>binding.issuerRuc)).size!==1)throw new B2bSecurityError(409,'INCONSISTENT_CONTEXT');
    const ruc=allowed[0].issuerRuc;
    if(action==='batch'){
      if(!b2bUuid(q.id))throw new B2bSecurityError(400,'INVALID_ID');
      return new BillingRead(this.repository,frame).batch(token,ruc,q.id);
    }
    let row:any;
    if(action==='lookup'){
      if(!['01','03'].includes(q.type))throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
      if(!/^[FB][A-Z0-9]{3}$/.test(q.series)||!/^[1-9][0-9]{0,17}$/.test(q.number))throw new B2bSecurityError(400,'INVALID_QUERY');
      row=await this.repository.document(ruc,{type:q.type as '01'|'03',series:q.series,number:BigInt(q.number)});
    }else{
      if(!b2bUuid(q.id))throw new B2bSecurityError(400,'INVALID_ID');row=await this.repository.document(ruc,{id:q.id});
    }
    const projection=await frame.authenticate(token,['integration:documents:read']);
    const result=this.documentProjection(row,principal,projection);
    if(action==='print-snapshot'){
      if(!this.printing)throw new B2bSecurityError(503,'PRINT_PROFILE_NOT_CONFIGURED');
      const presentation=await this.printing.snapshotForB2b(result.context,principal);
      await frame.principal(token,['b2b:documents:read','b2b:artifacts:read']);
      return {...result,snapshot:structuredClone(row.immutableSnapshot) as FiscalDocumentSnapshot,presentation:presentation??null};
    }
    await frame.principal(token,['b2b:documents:read']);return result;
  }
  private documentProjection(row:any,principal:B2bPrincipal,readPrincipal:any){
    if(!row)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    const type={INVOICE:'01',SALES_RECEIPT:'03'}[row.type as 'INVOICE'|'SALES_RECEIPT'];
    if(!type)throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
    const binding={issuerId:row.companyId,issuerRuc:row.company?.ruc,environment:'BETA',branchId:row.emissionPoint?.branchId,
      pointId:row.emissionPoint?.id,seriesId:row.seriesCounter?.id,documentType:type};
    if(!validB2bBinding(binding)||!b2bBindingsContain(principal.bindings,binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    const {document}=mapBillingDocument(row,readPrincipal,binding.issuerRuc,new Date());
    return {schemaVersion:'factuez.b2b.v1',context:binding,document,snapshotSha256:snapshotHash(row.immutableSnapshot)};
  }
}
export class PrismaB2bReadRepository extends PrismaBillingRead implements B2bBillingReadRepository {
  constructor(private readonly prisma:PrismaService){super(prisma);}
  contexts(bindings:B2bBinding[]){return this.prisma.$transaction(async tx=>{
    const context=new PrismaB2bContextRepository(tx as unknown as PrismaService),items:any[]=[];
    for(const binding of bindings){const item=await context.resolve(binding);if(item)items.push(item);}return items;
  },{isolationLevel:'RepeatableRead',timeout:15000});}
  products(){return this.prisma.fuelProduct.findMany({where:{active:true},take:10001,orderBy:{id:'asc'},select:{id:true,sku:true,description:true,unitCode:true,taxAffectationCode:true,defaultUnitPrice:true}});}
  async capture(filters:B2bDocumentFilters,bindings:B2bBinding[]){
    const from=new Date(filters.from+'T00:00:00-05:00'),until=new Date(Date.parse(filters.to+'T00:00:00-05:00')+86400000);
    return this.prisma.$transaction(async tx=>tx.document.findMany({
      where:{companyId:filters.issuerId,status:{in:['ISSUED','CANCELLED']},issueDate:{gte:from,lt:until},immutableSnapshot:{path:['environment'],equals:'BETA'},
        OR:bindings.map(binding=>({company:{ruc:binding.issuerRuc},emissionPointId:binding.pointId,seriesCounterId:binding.seriesId,
          emissionPoint:{branchId:binding.branchId,companyId:binding.issuerId},type:binding.documentType==='01'?'INVOICE' as const:'SALES_RECEIPT' as const}))},
      orderBy:[{issueDate:'asc'},{id:'asc'}],take:10001,
      select:{id:true,companyId:true,type:true,series:true,number:true,fullNumber:true,issueDate:true,status:true,sunatStatus:true,sunatResponseCode:true,originSystem:true,originId:true,payableAmount:true,updatedAt:true,immutableSnapshot:true,
        company:{select:{ruc:true}},emissionPoint:{select:{id:true,companyId:true,branchId:true,branch:{select:{companyId:true}}}},seriesCounter:{select:{id:true,companyId:true,emissionPointId:true,documentType:true,series:true}}},
    }),{isolationLevel:'RepeatableRead',timeout:15000});
  }
}
