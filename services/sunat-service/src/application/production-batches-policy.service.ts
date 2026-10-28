import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PRODUCTION_BATCHES_PROFILE } from '@factuez/contracts/production-batches';
import { PrismaService } from '../infrastructure/prisma.service';
import { FiscalConfigurationService } from './fiscal-configuration.service';
import { FiscalReadinessService } from './fiscal-readiness.service';
import type { ProductionBatchesGrant } from './production-batches-repository';
export const productionBatchesEnabled=()=>process.env.SUNAT_PRODUCTION_BATCHES_ENABLED==='true'&&process.env.SUNAT_PRODUCTION_WORKFLOW_ENABLED==='true';
@Injectable()
export class ProductionBatchesPolicyService {
 constructor(private readonly prisma:PrismaService,private readonly configuration:FiscalConfigurationService,private readonly readiness:FiscalReadinessService){}
 async configure(companyId:string,input:{enabled:boolean;expectedVersion:number;expectedRevision:number;confirmation:string},authorization:string,actorId:string){
  if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('Versión inválida');
  const config=await this.configuration.status(companyId,'PRODUCTION',authorization);
  if(config.revision!==input.expectedRevision)throw Error('Credenciales cambiaron');
  if(input.enabled){
   if(!productionBatchesEnabled()||input.confirmation!=='AUTORIZAR LOTES REALES RC03 RA01'||config.emissionEnvironment!=='PRODUCTION')throw Error('Autorización explícita del perfil de lotes requerida');
   const report=await this.readiness.inspect(companyId,'PRODUCTION',authorization);
   const required=['ISSUER_REAL_RUC','SECRET_VAULT','SOL_SECRETS_LOCAL','CERTIFICATE_KEY_PAIR','CERTIFICATE_RUC','CERTIFICATE_CHAIN','CERTIFICATE_REVOCATION','XSD_RUNTIME','CDR_TRUST'];
   if(report.revision!==config.revision||required.some(code=>!report.checks.some(c=>c.code===code&&c.status==='PASS')))throw Error('Verificación fiscal pendiente');
  }
  return this.prisma.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-batches:grant:'+config.ruc);
   const grants=await tx.$queryRawUnsafe<ProductionBatchesGrant[]>('SELECT * FROM "ProductionBatchesGrant" WHERE "issuerRuc"=$1 FOR UPDATE',config.ruc);
   if((grants[0]?.version??0)!==input.expectedVersion)throw Error('Grant cambió');
   const credentials=await tx.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:config.ruc,environment:'PRODUCTION'}}});
   if(credentials?.revision!==config.revision||input.enabled&&credentials.certificateFingerprint!==config.certificate.fingerprint)throw Error('Credenciales cambiaron');
   const grant={issuerRuc:config.ruc,profile:PRODUCTION_BATCHES_PROFILE,enabled:input.enabled,version:input.expectedVersion+1,credentialRevision:config.revision,fingerprint:config.certificate.fingerprint??'0'.repeat(64)};
   await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesGrant" ("issuerRuc","profile","enabled","version","credentialRevision","fingerprint","actorId") VALUES ($1,$2,$3,$4,$5,$6,$7::uuid) ON CONFLICT ("issuerRuc") DO UPDATE SET "enabled"=EXCLUDED."enabled","version"=EXCLUDED."version","profile"=EXCLUDED."profile","credentialRevision"=EXCLUDED."credentialRevision","fingerprint"=EXCLUDED."fingerprint","actorId"=EXCLUDED."actorId","updatedAt"=now()',grant.issuerRuc,grant.profile,grant.enabled,grant.version,grant.credentialRevision,grant.fingerprint,actorId);
   await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesGrantAudit" ("id","issuerRuc","version","payload") VALUES ($1::uuid,$2,$3,$4::jsonb)',randomUUID(),config.ruc,grant.version,JSON.stringify({...grant,actorId}));
   return grant;
  },{isolationLevel:'Serializable'});
 }
 async current(ruc:string,expected?:ProductionBatchesGrant|null){
  if(!productionBatchesEnabled())throw Error('Lotes deshabilitados');
  const rows=await this.prisma.$queryRawUnsafe<ProductionBatchesGrant[]>('SELECT * FROM "ProductionBatchesGrant" WHERE "issuerRuc"=$1',ruc),grant=rows[0];
  const credentials=await this.prisma.sunatCredentials.findUnique({where:{issuerRuc_environment:{issuerRuc:ruc,environment:'PRODUCTION'}}});
  if(!grant?.enabled||grant.profile!==PRODUCTION_BATCHES_PROFILE||!credentials||credentials.revision!==grant.credentialRevision||credentials.certificateFingerprint!==grant.fingerprint||
     credentials.certificateSelfSigned!==false||!credentials.certificateExpiresAt||credentials.certificateExpiresAt<=new Date()||
     expected&&(grant.version!==expected.version||grant.fingerprint!==expected.fingerprint||grant.credentialRevision!==expected.credentialRevision))throw Error('Grant revocado/desactualizado');
  return {grant,credentials};
 }
}
