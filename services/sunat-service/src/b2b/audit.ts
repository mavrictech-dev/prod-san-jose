import type { PrismaService } from '../infrastructure/prisma.service';
import type { B2bDownloadAudit } from './read';
export class PostgresB2bDownloadAudit implements B2bDownloadAudit {
  constructor(private readonly db:PrismaService){}
  async record(event:Parameters<B2bDownloadAudit['record']>[0]){
    const p=event.principal;
    await this.db.$executeRawUnsafe(`INSERT INTO "B2bArtifactAudit" ("id","clientId","clientRevision","actorKind","subjectId","userAuthRevision","issuerRuc","ownerId","artifactId","representation","sha256","byteLength") VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8::uuid,$9::uuid,$10,$11,$12)`,
      event.id,p.clientId,p.revision,p.kind,p.subjectId,p.userAuthRevision,event.issuerRuc,event.ownerId,event.artifactId,event.representation,event.sha256,event.byteLength);
  }
}
