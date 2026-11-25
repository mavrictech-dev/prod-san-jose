import {Body,Controller,Headers,HttpCode,Injectable,Post,Req,type OnModuleDestroy} from '@nestjs/common';
import {NativeB2bRpc,nativeB2bPrivatePeer,nativeServiceBearer} from '@factuez/service-access/dist/native-b2b-rpc';
import {binding,deny} from '@factuez/service-access/dist/b2b-production-contract';
import {fiscalSnapshotSha256,assertProductionNotesOwner} from '@factuez/sunat-core';
import {createHash} from 'node:crypto';
import {ProductionDispatchPolicy} from './application/production-dispatch-policy';
import {ProductionNotesPolicyService} from './application/production-notes-policy.service';
import {ProductionNotesEvidenceService} from './application/production-notes-evidence.service';
import {FiscalOriginalsService} from './application/fiscal-originals.service';
import {ArtifactDeliveryService} from './application/artifact-delivery.service';
@Injectable()
export class NativeB2bFiscalAuthority implements OnModuleDestroy {
 private channel?:NativeB2bRpc;
 rpc(){return this.channel??=NativeB2bRpc.configured();}
 onModuleDestroy(){this.channel?.close();}
 async admission(request:any,authorization:string,body:any,code:string){
  nativeB2bPrivatePeer(request,'billing');
  if(!body||Object.keys(body).sort().join(',')!=='binding,payload')deny(400,'INVALID_BODY');
  const b=binding(body.binding);await this.rpc().introspect(nativeServiceBearer(authorization));
  const native=await this.rpc().post('billing','/internal/native-b2b/billing/resolve',{binding:b,code},authorization);
  return {binding:native,payload:body.payload};
 }
 async original(authorization:string,original:any,native:any){
  if(!original||original.environment!=='PRODUCTION'||original.companyId!==native.companyId||original.branchId!==native.branchId||original.issuer?.identityNumber!==native.issuerRuc)deny(403,'NOTE_ORIGINAL_BINDING_MISMATCH');
  const own=await this.rpc().post('billing','/internal/native-b2b/billing/document',{documentId:original.documentId},authorization);
  if(own.emissionPointId!==native.pointId||fiscalSnapshotSha256(own.immutableSnapshot)!==fiscalSnapshotSha256(original))deny(403,'NOTE_ORIGINAL_BINDING_MISMATCH');
 }
}
@Controller('internal/native-b2b/fiscal')
export class NativeB2bFiscalController {
 constructor(private readonly authority:NativeB2bFiscalAuthority,private readonly dispatch:ProductionDispatchPolicy,
  private readonly notes:ProductionNotesPolicyService,private readonly evidence:ProductionNotesEvidenceService,
  private readonly originals:FiscalOriginalsService,private readonly pdf:ArtifactDeliveryService){}
 @Post('health') @HttpCode(200) health(@Req() req:any,@Body() body:any){nativeB2bPrivatePeer(req,'billing');if(!body||Object.keys(body).length)deny(400,'INVALID_BODY');return {profile:'NATIVE_B2B',owner:'fiscal',state:'PRIVATE_CHANNEL_AVAILABLE'};}
 @Post('admission') @HttpCode(200) async admission(@Req() req:any,@Headers('authorization') a:string,@Body() body:any){
  const snapshot=body?.payload?.snapshot,code=snapshot?.documentTypeCode;
  if(!['01','03'].includes(code)||Object.keys(body.payload).join(',')!=='snapshot')deny(400,'INVALID_BODY');
  const {binding:n}=await this.authority.admission(req,a,body,code);
  if(snapshot.companyId!==n.companyId||snapshot.branchId!==n.branchId||snapshot.series!==n.series||snapshot.issuer?.identityNumber!==n.issuerRuc)deny(403,'PAYLOAD_BINDING_MISMATCH');
  return this.dispatch.admit(String(n.companyId),snapshot,a);
 }
 @Post('notes/original-evidence') @HttpCode(200) async original(@Req() req:any,@Headers('authorization') a:string,@Body() body:any){
  if(!body?.payload||Object.keys(body.payload).sort().join(',')!=='code,original'||!['07','08'].includes(body.payload.code))deny(400,'INVALID_BODY');
  const {binding:n,payload:p}=await this.authority.admission(req,a,body,body.payload.code);
  await this.authority.original(a,p.original,n);return this.evidence.original(p.original);
 }
 @Post('notes/admission') @HttpCode(200) async note(@Req() req:any,@Headers('authorization') a:string,@Body() body:any){
  const p=body?.payload;if(!p||Object.keys(p).sort().join(',')!=='body,ownerProof')deny(400,'INVALID_BODY');
  const v=p.body;if(!v||Object.keys(v).sort().join(',')!=='creditHistory,original,ownerRevisionSha256,snapshot'||!['07','08'].includes(v.snapshot?.documentTypeCode))deny(400,'INVALID_BODY');
  const {binding:n}=await this.authority.admission(req,a,body,v.snapshot.documentTypeCode);
  assertProductionNotesOwner(v,'admission',p.ownerProof);
  await this.authority.original(a,v.original,n);
  if(v.snapshot.companyId!==n.companyId||v.snapshot.branchId!==n.branchId||v.snapshot.series!==n.series)deny(403,'PAYLOAD_BINDING_MISMATCH');
  return this.notes.admit(v.snapshot,v.original,v.creditHistory);
 }
 @Post('artifact') @HttpCode(200) async artifact(@Req() req:any,@Headers('authorization') a:string,@Body() body:any){
  nativeB2bPrivatePeer(req,'billing');await this.authority.rpc().introspect(nativeServiceBearer(a));
  if(!body||Object.keys(body).some(k=>!['documentId','kind','format'].includes(k))||!['xml','cdr','pdf'].includes(body.kind)||body.format!==undefined&&(body.kind!=='pdf'||!['a4','ticket'].includes(body.format)))deny(400,'INVALID_BODY');
  const file=body.kind==='pdf'?await this.pdf.download(body.documentId,body.format??'a4',a):await this.originals.download(body.documentId,body.kind==='cdr'?'cdr-zip':'xml',a);
  return {name:file.fileName,mediaType:body.kind==='pdf'?'application/pdf':(file as unknown as {mediaType:string}).mediaType,sha256:createHash('sha256').update(file.bytes).digest('hex'),bytes:file.bytes.toString('base64')};
 }
}
