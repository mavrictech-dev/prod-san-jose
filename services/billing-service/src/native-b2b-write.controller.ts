import {Body,Controller,Get,Header,Headers,HttpCode,Param,Post,Query,Res} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {nativeServicePrincipalId} from '@factuez/service-access/dist/native-b2b-rpc';
import {deny,type ProductionActor} from '@factuez/service-access/dist/b2b-production-contract';
import {NativeB2bBillingAuthority} from './native-b2b-authority';
import {NativeB2bReads,nativeReadQuery,filterNativeBindings} from './native-b2b-read';
import {NativeB2bCommands} from './native-b2b-commands';
import {ProductionGuidesOwner,type ProductionGuidesActor} from './production-guides-owner';
import {ProductionNotesOwnerService} from './application/production-notes-owner.service';
@Controller('b2b/v1')
export class NativeB2bWriteController {
 constructor(private readonly authority:NativeB2bBillingAuthority,private readonly reads:NativeB2bReads,private readonly commands:NativeB2bCommands,private readonly guides:ProductionGuidesOwner,private readonly notes:ProductionNotesOwnerService){}
 @Post('documents') @HttpCode(202) @Header('Cache-Control','private, no-store') issue(@Headers('authorization') a:string,@Headers('idempotency-key') key:string,@Body() body:unknown){return this.commands.execute(a,body,key,'documents');}
 @Post('documents/:id/notes') @HttpCode(202) @Header('Cache-Control','private, no-store') note(@Headers('authorization') a:string,@Headers('idempotency-key') key:string,@Param('id') id:string,@Body() body:unknown){return this.commands.execute(a,body,key,'notes',id);}
 @Post('guides') @HttpCode(202) @Header('Cache-Control','private, no-store') guide(@Headers('authorization') a:string,@Headers('idempotency-key') key:string,@Body() body:unknown){return this.commands.execute(a,body,key,'guides');}
 @Get('operations/:id') @Header('Cache-Control','private, no-store') async operation(@Headers('authorization') a:string,@Param('id') id:string){return this.commands.operation(await this.authority.actor(a),id);}
 private guideActor(actor:ProductionActor,scope:ProductionGuidesActor['scope']):ProductionGuidesActor{return {principalId:nativeServicePrincipalId(actor.clientId),service:{kind:'SERVICE',clientId:actor.clientId,revision:actor.revision,environment:'PRODUCTION'},scope};}
 @Get('guides/capabilities') @Header('Cache-Control','private, no-store') async guideCapabilities(@Headers('authorization') a:string,@Query() query:unknown){
  const q=nativeReadQuery(query),actor=await this.authority.actor(a),value=await this.authority.readAuthority(actor,'production:masters:read');
  if(!q.pointId||!filterNativeBindings(value.bindings,q).some(n=>n.pointId===q.pointId&&['09','31'].includes(n.documentType)))deny(403,'NATIVE_BINDING_DENIED');
  return this.guides.capabilities(q.pointId,this.guideActor(actor,value.scope));
 }
 @Get('guides/carrier-reference') @Header('Cache-Control','private, no-store') async carrier(@Headers('authorization') a:string,@Query() q:any){
  if(!q||Object.keys(q).sort().join(',')!=='issuerRuc,number,series,seriesCounterId'||Object.values(q).some(v=>typeof v!=='string'))deny(400,'INVALID_READ_QUERY');
  const actor=await this.authority.actor(a),value=await this.authority.readAuthority(actor,'production:masters:read');
  if(!value.bindings.some(n=>n.seriesId===q.seriesCounterId&&n.documentType==='31'))deny(403,'NATIVE_BINDING_DENIED');
  return this.guides.carrierReference(q.seriesCounterId,{issuerRuc:q.issuerRuc,series:q.series,number:q.number},this.guideActor(actor,value.scope));
 }
 @Get('documents/:id/notes/prepare') @Header('Cache-Control','private, no-store') async notePrepare(@Headers('authorization') a:string,@Param('id') id:string,@Query() query:unknown){
  const q=nativeReadQuery(query,['documentType']),code=q.documentType;
  if(!q.issuerRuc||!q.branchId||!q.pointId||!q.series||!['07','08'].includes(code??''))deny(400,'INVALID_NOTE_PAYLOAD');
  const actor=await this.authority.actor(a);await this.reads.document(actor,id);
  const n=await this.authority.resolve(actor,code==='07'?'production:notes:issue:07':'production:notes:issue:08',{ruc:q.issuerRuc,branchId:q.branchId,pointId:q.pointId,series:q.series});
  return this.notes.readyB2B(id,this.commands.context(actor,n,a,'00000000-0000-5000-8000-000000000001'));
 }
 @Get('documents/:id/status') @Header('Cache-Control','private, no-store') async status(@Headers('authorization') a:string,@Param('id') id:string){
  const actor=await this.authority.actor(a),{document:d,actorScope}=await this.reads.document(actor,id);
  if(d.type==='DESPATCH_ADVICE')return this.guides.status(id,this.guideActor(actor,actorScope));
  return {documentId:d.id,fullNumber:d.fullNumber,status:d.status,sunatStatus:d.sunatStatus,environment:'PRODUCTION',acceptedBySunat:['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(d.sunatStatus),updatedAt:d.updatedAt};
 }
 @Get('documents/:id/artifacts/:kind') async artifact(@Headers('authorization') a:string,@Param('id') id:string,@Param('kind') kind:string,@Query() q:any,@Res() res:any){
  if(!['xml','pdf','cdr'].includes(kind)||Object.keys(q).some(k=>k!=='format')||q.format!==undefined&&(kind!=='pdf'||!['a4','ticket'].includes(q.format)))deny(400,'INVALID_ARTIFACT_KIND');
  const actor=await this.authority.actor(a),{document:d,actorScope}=await this.reads.document(actor,id);let bytes:Buffer,name:string,mediaType:string,digest:string;
  if(d.type==='DESPATCH_ADVICE'){
   const principal=this.guideActor(actor,actorScope);
   if(kind==='pdf'){if(q.format&&q.format!=='a4')deny(400,'INVALID_PDF_FORMAT');bytes=await this.guides.pdf(id,principal);name=id+'.pdf';mediaType='application/pdf';digest=createHash('sha256').update(bytes).digest('hex');}
   else {const file=await this.guides.artifact(id,kind==='xml'?'signed-xml':'cdr-zip',principal);bytes=file.bytes;name=file.name;mediaType=file.mediaType;digest=file.sha256;}
  }else{
   const file=await this.authority.rpc().post('fiscal','/internal/native-b2b/fiscal/artifact',{documentId:id,kind,...(q.format?{format:q.format}:{})},a);
   if(!file||typeof file.bytes!=='string'||file.bytes.length>64*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256)||typeof file.name!=='string'||! /^[A-Za-z0-9_.-]{1,240}$/.test(file.name)||file.mediaType!==(kind==='pdf'?'application/pdf':kind==='cdr'?'application/zip':'application/xml'))deny(503,'INVALID_ARTIFACT_RESPONSE');
   bytes=Buffer.from(file.bytes,'base64');if(bytes.toString('base64')!==file.bytes)deny(503,'INVALID_ARTIFACT_RESPONSE');name=file.name;mediaType=file.mediaType;digest=file.sha256;
  }
  if(!bytes.length||createHash('sha256').update(bytes).digest('hex')!==digest)deny(503,'ARTIFACT_HASH_MISMATCH');
  res.set({'Content-Type':mediaType,'Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Content-SHA256':digest});res.send(bytes);
 }
}
