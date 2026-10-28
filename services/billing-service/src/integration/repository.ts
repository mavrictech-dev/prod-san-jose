import { PrismaService } from '../infrastructure/prisma.service';
import { deny } from '@factuez/service-access/dist/integration';
import type { BillingCatalog, BillingReadRepository } from './read';
const typeCode = { INVOICE:'01', SALES_RECEIPT:'03', CREDIT_NOTE:'07', DEBIT_NOTE:'08' } as const;
const typeName = { '01':'INVOICE', '03':'SALES_RECEIPT', '07':'CREDIT_NOTE', '08':'DEBIT_NOTE' } as const;
export class PrismaBillingRead implements BillingReadRepository {
  constructor(private readonly db: PrismaService) {}
  async batch(issuerRuc: string,id: string) {
    const row=await this.db.dailySummary.findFirst({where:{id,company:{ruc:issuerRuc}},select:{identifier:true,
      items:{take:10001,orderBy:{lineNumber:'asc'},select:{documentId:true,conditionCode:true}}}});
    if (row && row.items.length>10000) return deny(409,'INCOMPLETE_BINDING');
    return row;
  }
  document(issuerRuc: string, key: {id:string}|{type:keyof typeof typeName;series:string;number:bigint}) {
    return this.db.document.findFirst({ where: { company:{ruc:issuerRuc}, immutableSnapshot:{path:['environment'],equals:'BETA'},
      ...('id' in key ? {id:key.id} : {type:typeName[key.type],series:key.series,number:key.number}) },
      select: { id:true,companyId:true,type:true,series:true,number:true,fullNumber:true,issueDate:true,status:true,sunatStatus:true,
        sunatResponseCode:true,originSystem:true,originId:true,payableAmount:true,updatedAt:true,immutableSnapshot:true,
        company:{select:{ruc:true}},
        emissionPoint:{select:{id:true,companyId:true,branchId:true,branch:{select:{companyId:true}}}},
        seriesCounter:{select:{id:true,companyId:true,emissionPointId:true,documentType:true,series:true}} } });
  }
  async catalog(issuerRuc: string): Promise<BillingCatalog|null> {
    return this.db.$transaction(async tx=> {
      const company = await tx.companySettings.findUnique({where:{ruc:issuerRuc},select:{id:true,ruc:true,legalName:true,environment:true,active:true}});
      if (!company || company.environment !== 'BETA') return null;
      const branches = await tx.branch.findMany({where:{companyId:company.id},take:10001,orderBy:{id:'asc'},
        select:{id:true,code:true,name:true,active:true,address:true}});
      const points = await tx.emissionPoint.findMany({where:{companyId:company.id},take:10001,orderBy:{id:'asc'},
        select:{id:true,branchId:true,code:true,name:true,active:true,counters:{where:{companyId:company.id},take:10001,
          orderBy:{id:'asc'},select:{id:true,documentType:true,series:true,active:true}}}});
      if (branches.length>10000 || points.length>10000 || points.some(p=>p.counters.length>100)) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
      const ids=new Set(branches.map(b=>b.id));
      if (points.some(p=>!p.branchId || !ids.has(p.branchId))) return deny(409,'INCOMPLETE_BINDING');
      return {issuer:{issuerRuc,legalName:company.legalName,environment:'BETA',active:company.active},observedAt:new Date().toISOString(),
        branches:branches.map(b=>({...b,issuerRuc,establishmentCode:null})),
        points:points.map(p=>({id:p.id,branchId:p.branchId!,issuerRuc,code:p.code,name:p.name,active:p.active,
          series:p.counters.filter(s=>s.documentType in typeCode).map(s=>({id:s.id,type:typeCode[s.documentType as keyof typeof typeCode],label:s.series,active:s.active}))}))};
    },{isolationLevel:'RepeatableRead'});
  }
}
