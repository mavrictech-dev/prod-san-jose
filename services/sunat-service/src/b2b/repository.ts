import type { PrismaService } from '../infrastructure/prisma.service';
import { PrismaSunatRead } from '../integration/repository';
/** B2B-specific status projection; does not change the frozen legacy read adapter. */
export class PrismaB2bSunatRead extends PrismaSunatRead {
  constructor(private readonly b2bDb:PrismaService){super(b2bDb);}
  document(issuerRuc:string,documentId:string){return this.b2bDb.fiscalDocument.findFirst({where:{issuerRuc,documentId,environment:'BETA'},
    select:{documentId:true,issuerRuc:true,environment:true,documentType:true,series:true,number:true,immutablePayload:true,status:true,
      artifacts:{take:33,select:{id:true,kind:true,storageKey:true,mediaType:true,sizeBytes:true,sha256:true,createdAt:true}}}});}
}
