import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import { IssueDocumentService } from '../application/issue-document.service';
import type { PrismaService } from '../infrastructure/prisma.service';
import type { DraftIssuer } from './draft-store';

export const B2B_ISSUANCE_PROFILE='BETA_01_03_TAXABLE18_V1' as const;
/** Explicit candidate binding. No environment auto-enable, network, keys or queue publisher. */
export function b2bDraftIssuer(service:IssueDocumentService,policy:{profile:typeof B2B_ISSUANCE_PROFILE;allowedIssuerRucs:readonly string[]}):DraftIssuer {
  if(policy.profile!==B2B_ISSUANCE_PROFILE||!policy.allowedIssuerRucs.length||policy.allowedIssuerRucs.some(r=>!/^\d{11}$/.test(r)))
    throw new Error('Explicit BETA issuance profile and issuer allowlist required');
  const allowed=new Set(policy.allowedIssuerRucs);
  return async(db,draft,operation)=>{
    const b=draft.binding,body=draft.body;
    if(b.environment!=='BETA'||!allowed.has(b.issuerRuc))throw new B2bSecurityError(409,'PROFILE_NOT_ENABLED');
    if(operation.action!=='ISSUE'||operation.draftId!==draft.id||draft.state!=='DRAFT'||draft.validatedRevision!==draft.revision)
      throw new B2bSecurityError(409,'DRAFT_VALIDATION_REQUIRED');
    // Reuse the SAME Prisma transaction. Never invoke execute(), which would nest a commit.
    let document;
    try{document=await service.executeWithinTransaction({emissionPointId:b.pointId,documentType:b.documentType==='01'?'INVOICE':'SALES_RECEIPT',
      series:await seriesLabel(db,b.seriesId),issueDate:body.issueDate+'T00:00:00-05:00',currencyCode:body.currency,paymentTerms:{type:'CONTADO'},
      customer:body.customer,lines:body.lines},
      {idempotencyKey:'b2b:draft:'+draft.id,userId:operation.actor.subjectId,correlationId:operation.commandId,
        scope:{kind:'ASSIGNED',branchIds:[b.branchId],emissionPointIds:[b.pointId],series:[b.seriesId]},
        b2b:{binding:b,draftId:draft.id,actor:operation.actor}},db as PrismaService);
    }catch(e){if(e instanceof B2bSecurityError)throw e;if(e instanceof HttpException&&[400,403,404,409,422].includes(e.getStatus()))
      throw new B2bSecurityError(e.getStatus(),'ISSUANCE_PROFILE_OR_CONTEXT_REJECTED');throw e;}
    const result={documentId:document.id,series:document.series,number:document.number.toString(),fullNumber:document.fullNumber};
    const event={schemaVersion:'factuez.b2b.v1',eventId:randomUUID(),eventType:'document.issued-locally.v1',operationId:operation.id,
      commandId:operation.commandId,draftId:draft.id,documentId:document.id,context:b,occurredAt:operation.at,
      snapshotSha256:snapshotHash(document.immutableSnapshot),fiscalAcceptance:'NOT_ASSERTED'};
    // Independent publication cursor; never compete for legacy OutboxEvent.publishedAt.
    await db.$executeRawUnsafe(`INSERT INTO "B2bCommitEvent" ("id","operationId","documentId","clientId","actorKey","binding","payload","createdAt")
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7::jsonb,$8::timestamptz)`,
      event.eventId,operation.id,document.id,operation.clientId,operation.actorKey,JSON.stringify(b),JSON.stringify(event),operation.at);
    return result;
  };
}
async function seriesLabel(db:Parameters<DraftIssuer>[0],id:string){
  const rows=await db.$queryRawUnsafe<{series:string}[]>('SELECT "series" FROM "SeriesCounter" WHERE "id"=$1::uuid',id);
  if(!rows[0])throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');return rows[0].series;
}
