import { Body,Controller,ForbiddenException,Inject,Post,Req,BadRequestException } from '@nestjs/common';
import type { ProductionGuidesGrant as Grant,ProductionGuidesSnapshot as Snapshot,ProductionGuidesIssued as Issued,ProductionGuidesScope,ProductionGuidesStatusEvent,ProductionGuidesArtifactKind as Kind,ProductionGuidesReference09 } from '@factuez/contracts/production-guides';
import { ProductionGuidesPrivateHttp,productionGuidesPrivatePeer } from '@factuez/sunat-core/dist/production-guides-private';
import { productionGuidesBytesHash as hash,productionGuidesExact as exact } from '@factuez/sunat-core/dist/production-guides';
import { ProductionGuidesService } from './production-guides-service';
export const PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS='PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS';
export const PRODUCTION_GUIDES_GRANT_EVIDENCE='PRODUCTION_GUIDES_GRANT_EVIDENCE';
export type ProductionGuidesGrantEvidence=(scope:ProductionGuidesScope,profiles:Grant['profiles'],revision:number)=>Promise<Pick<Grant,'credentialRevision'|'certificateFingerprint'|'rulesSha256'|'xsdSha256'>>;
export class ProductionGuidesBillingPrivateClient {
 constructor(private readonly http:ProductionGuidesPrivateHttp){}
 current(event:Issued){return this.http.post<Grant>('/internal/production-guides/billing/current',event);}
 currentGrant(grant:Grant){return this.http.post<Grant>('/internal/production-guides/billing/grant-current',grant);}
 referenceOwner(requester:Snapshot){return this.http.post<Issued>('/internal/production-guides/billing/reference-owner',requester);}
 async receive(event:ProductionGuidesStatusEvent){await this.http.post('/internal/production-guides/billing/status',event);}
}
@Controller('internal/production-guides/sunat')
export class ProductionGuidesSunatPrivateController {
 constructor(private readonly service:ProductionGuidesService,@Inject(PRODUCTION_GUIDES_SUNAT_PRIVATE_PEERS)private readonly peers:readonly string[],@Inject(PRODUCTION_GUIDES_GRANT_EVIDENCE)private readonly evidence:ProductionGuidesGrantEvidence){}
 private peer(r:any){try{productionGuidesPrivatePeer(r,this.peers);}catch{throw new ForbiddenException('Puerto privado Billing requerido');}}
 @Post('grant-evidence') grant(@Body() body:{scope:ProductionGuidesScope;profiles:Grant['profiles'];credentialRevision:number},@Req() r:any){this.peer(r);exact(body,['scope','profiles','credentialRevision']);return this.evidence(body.scope,body.profiles,body.credentialRevision);}
 @Post('admit') async admit(@Body() body:{snapshot:Snapshot;grant:Grant},@Req() r:any){this.peer(r);exact(body,['snapshot','grant']);await this.service.admit(body.snapshot,body.grant);return {accepted:true};}
 @Post('ingest') ingest(@Body() event:Issued,@Req() r:any){this.peer(r);return this.service.ingest(event);}
 @Post('status') status(@Body() event:Issued,@Req() r:any){this.peer(r);return this.service.status(event);}
 @Post('artifact') async artifact(@Body() body:{event:Issued;kind:Kind},@Req() r:any){this.peer(r);exact(body,['event','kind']);const a=await this.service.artifact(body.event,body.kind);return {name:a.name,mediaType:a.mediaType,sha256:a.sha256,base64:a.bytes.toString('base64')};}
 @Post('pdf') async pdf(@Body() event:Issued,@Req() r:any){this.peer(r);const b=await this.service.pdf(event);return {base64:b.toString('base64'),sha256:hash(b)};}
 @Post('reference-evidence') reference(@Body() requester:Snapshot,@Req() r:any):Promise<ProductionGuidesReference09>{this.peer(r);return this.service.reference09(requester);}
}
