import { PrismaService } from '../infrastructure/prisma.service';
import { deny } from '@factuez/service-access/dist/integration';
import type { StoredArtifact, SunatReadRepository } from './read';
const artifactSelect={id:true,kind:true,storageKey:true,mediaType:true,sizeBytes:true,sha256:true,createdAt:true} as const;
export class PrismaSunatRead implements SunatReadRepository {
  constructor(private readonly db:PrismaService) {}
  document(issuerRuc:string,documentId:string) {return this.db.fiscalDocument.findFirst({where:{issuerRuc,documentId,environment:'BETA'},
    select:{documentId:true,issuerRuc:true,environment:true,documentType:true,series:true,number:true,immutablePayload:true,
      artifacts:{take:33,select:artifactSelect}}});}
  batch(issuerRuc:string,id:string) {return this.db.fiscalBatch.findFirst({where:{issuerRuc,id,environment:'BETA'},
    select:{id:true,summaryId:true,issuerRuc:true,environment:true,identifier:true,immutablePayload:true,artifacts:{take:33,select:artifactSelect}}});}
  async artifact(issuerRuc:string,id:string) {
    const [document,batch]=await Promise.all([
      this.db.documentArtifact.findFirst({where:{id,document:{issuerRuc,environment:'BETA'}},select:{...artifactSelect,documentId:true}}),
      this.db.batchArtifact.findFirst({where:{id,batch:{issuerRuc,environment:'BETA'}},select:{...artifactSelect,batchId:true}})]);
    if (document && batch) return deny(409,'INCOMPLETE_BINDING');
    return document?{artifact:document,owner:{kind:'DOCUMENT' as const,id:document.documentId}}:
      batch?{artifact:batch,owner:{kind:'BATCH' as const,id:batch.batchId}}:null;
  }
  async sharedCdr(issuerRuc:string,a:StoredArtifact,documentId:string) {
    // A copied document CDR must retain the authorization of the canonical batch bytes.
    const rows=await this.db.batchArtifact.findMany({where:{sha256:a.sha256,kind:a.kind as 'CDR_XML'|'CDR_ZIP',
      batch:{issuerRuc,environment:'BETA'}},take:3,select:{...artifactSelect,batchId:true}});
    if (rows.length>1) return deny(409,'INCOMPLETE_BINDING');
    // Hash equality alone cannot establish an individual CDR when batch metadata is missing.
    // Read only bindings, never log bodies, response descriptions, credentials or submission errors.
    const logs=await this.db.cdrLog.findMany({where:{documentId,document:{issuerRuc,environment:'BETA'}},take:101,
      select:{batchId:true,submission:{select:{batchId:true}}}});
    if (logs.length>100) return deny(409,'INCOMPLETE_BINDING');
    const links=new Set(logs.flatMap(l=>[l.batchId,l.submission.batchId]).filter((id):id is string=>!!id));
    if (links.size && (rows.length!==1 || links.size!==1 || !links.has(rows[0].batchId))) return deny(409,'INCOMPLETE_BINDING');
    return rows.map(row=>({artifact:row,batchId:row.batchId}));
  }
  async ready() {await this.db.$queryRaw`SELECT 1 FROM "IntegrationReadAudit" LIMIT 0`;}
  async audit(e:Parameters<SunatReadRepository['audit']>[0]) {
    await this.db.$executeRaw`INSERT INTO "IntegrationReadAudit" ("id","clientId","revision","issuerRuc","artifactId","sha256","byteLength","outcome")
      VALUES (${e.id}::uuid,${e.clientId}::uuid,${e.revision},${e.issuerRuc},${e.artifactId}::uuid,${e.sha256},${e.byteLength},'READ_VERIFIED')`;
  }
}
