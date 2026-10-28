import { B2bSecurityError, b2bBindingsContain, validB2bBinding, validB2bPrincipal, type B2bBinding, type B2bIdentityScope, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import type { PrismaService } from '../infrastructure/prisma.service';
export interface ContextRepository { resolve(binding:B2bBinding):Promise<unknown|null> }
export interface ContextIdentity { authenticate(token:string,scopes:B2bIdentityScope[],kind:'SERVICE'|'USER'):Promise<B2bPrincipal> }
export class B2bContextService {
  constructor(private readonly repository:ContextRepository,private readonly identity:ContextIdentity){}
  async resolve(token:string,binding:unknown,kind:'SERVICE'|'USER'){
    if(!validB2bBinding(binding)||!['SERVICE','USER'].includes(kind))throw new B2bSecurityError(400,'INVALID_BINDING');
    const principal=await this.identity.authenticate(token,['b2b:catalog:read'],kind);
    if(!validB2bPrincipal(principal)||principal.kind!==kind||!principal.scopes.includes('b2b:catalog:read'))throw new B2bSecurityError(401,'INVALID_PRINCIPAL');
    if(!b2bBindingsContain(principal.bindings,binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    const resolved=await this.repository.resolve(binding);
    if(!resolved)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    return resolved;
  }
  async validate(bindings:unknown){
    if(!Array.isArray(bindings)||!bindings.length||bindings.length>500||!bindings.every(validB2bBinding))throw new B2bSecurityError(400,'INVALID_BINDINGS');
    // Each tuple is validated as one hierarchy, never independent ID membership.
    for(const binding of bindings)if(!await this.repository.resolve(binding))throw new B2bSecurityError(400,'INVALID_BINDINGS');
    return {valid:true};
  }
}
export class PrismaB2bContextRepository implements ContextRepository {
  constructor(private readonly db:PrismaService){}
  async resolve(binding:B2bBinding){
    const row=await this.db.seriesCounter.findFirst({where:{id:binding.seriesId,companyId:binding.issuerId,emissionPointId:binding.pointId,active:true,
      documentType:binding.documentType==='01'?'INVOICE':'SALES_RECEIPT',company:{ruc:binding.issuerRuc,environment:'BETA',active:true},
      emissionPoint:{id:binding.pointId,companyId:binding.issuerId,branchId:binding.branchId,active:true,branch:{id:binding.branchId,companyId:binding.issuerId,active:true}}},
      select:{id:true,series:true,company:{select:{id:true,ruc:true,legalName:true}},emissionPoint:{select:{id:true,code:true,name:true,branch:{select:{id:true,code:true,name:true}}}}}});
    return row?{binding:structuredClone(binding),issuer:{id:row.company.id,ruc:row.company.ruc,legalName:row.company.legalName},
      branch:row.emissionPoint.branch,point:{id:row.emissionPoint.id,code:row.emissionPoint.code,name:row.emissionPoint.name},series:{id:row.id,label:row.series,type:binding.documentType}}:null;
  }
}
