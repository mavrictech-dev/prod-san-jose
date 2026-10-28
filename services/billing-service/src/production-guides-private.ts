import { Body,Controller,ForbiddenException,Inject,Post,Req } from '@nestjs/common';
import type { ProductionGuidesGrant as Grant,ProductionGuidesSnapshot as Snapshot,ProductionGuidesIssued as Issued,ProductionGuidesScope,ProductionGuidesStatusEvent,ProductionGuidesArtifactKind as Kind } from '@factuez/contracts/production-guides';
import { ProductionGuidesPrivateHttp,productionGuidesPrivatePeer } from '@factuez/sunat-core/dist/production-guides-private';
import { productionGuidesBytesHash as hash } from '@factuez/sunat-core/dist/production-guides';
import { ProductionGuidesOwner } from './production-guides-owner';
export const PRODUCTION_GUIDES_BILLING_PRIVATE_PEERS='PRODUCTION_GUIDES_BILLING_PRIVATE_PEERS';
export class ProductionGuidesSunatPrivateClient {
 constructor(private readonly http:ProductionGuidesPrivateHttp){}
 admit(snapshot:Snapshot,grant:Grant){return this.http.post<void>('/internal/production-guides/sunat/admit',{snapshot,grant});}
 grantEvidence(scope:ProductionGuidesScope,profiles:Grant['profiles'],credentialRevision:number){return this.http.post<Pick<Grant,'credentialRevision'|'certificateFingerprint'|'rulesSha256'|'xsdSha256'>>('/internal/production-guides/sunat/grant-evidence',{scope,profiles,credentialRevision});}
 ingest(event:Issued){return this.http.post('/internal/production-guides/sunat/ingest',event);}
 status(event:Issued){return this.http.post<import('@factuez/contracts/production-guides').ProductionGuidesResult>('/internal/production-guides/sunat/status',event);}
 async artifact(event:Issued,kind:Kind){const a=await this.http.post<{name:string;mediaType:string;sha256:string;base64:string}>('/internal/production-guides/sunat/artifact',{event,kind});const bytes=Buffer.from(a.base64,'base64');if(bytes.toString('base64')!==a.base64||hash(bytes)!==a.sha256)throw Error('GRE_PRIVATE_ORIGINAL_CHANGED');return {name:a.name,mediaType:a.mediaType,sha256:a.sha256,bytes};}
 async pdf(event:Issued){const a=await this.http.post<{base64:string;sha256:string}>('/internal/production-guides/sunat/pdf',event),b=Buffer.from(a.base64,'base64');if(b.toString('base64')!==a.base64||hash(b)!==a.sha256)throw Error('GRE_PRIVATE_PDF_CHANGED');return b;}
}
@Controller('internal/production-guides/billing')
export class ProductionGuidesBillingPrivateController {
 constructor(private readonly owner:ProductionGuidesOwner,@Inject(PRODUCTION_GUIDES_BILLING_PRIVATE_PEERS)private readonly peers:readonly string[]){}
 private peer(r:any){try{productionGuidesPrivatePeer(r,this.peers);}catch{throw new ForbiddenException('Puerto privado SUNAT requerido');}}
 @Post('current') current(@Body() event:Issued,@Req() r:any){this.peer(r);return this.owner.current(event);}
 @Post('grant-current') grant(@Body() grant:Grant,@Req() r:any){this.peer(r);return this.owner.currentGrant(grant);}
 @Post('reference-owner') reference(@Body() requester:Snapshot,@Req() r:any){this.peer(r);return this.owner.referenceOwner(requester);}
 @Post('status') async status(@Body() event:ProductionGuidesStatusEvent,@Req() r:any){this.peer(r);await this.owner.applyStatus(event);return {accepted:true};}
}
