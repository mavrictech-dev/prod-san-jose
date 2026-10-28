import {Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {BatchMemberEvidence} from '../application/batch-member-evidence';
import {BatchEvidenceRepositoryError} from '../application/batch-member-evidence.repository';
import {PersistentBatchMemberEvidence} from './batch-member-evidence-assembly';
import {batchEvidenceLimits,batchEvidenceRequest,batchEvidenceResponse,evidenceFresh,evidenceRequire} from './batch-member-evidence-protocol';
const CORE=Symbol('SUNAT batch member verifier'),PEERS=Symbol('Billing-only batch evidence peers'),CLOCK=Symbol('Batch evidence clock');
@Catch()
export class BatchMemberEvidenceFilter{
 catch(error:unknown,host:ArgumentsHost){
  const status=error instanceof B2bSecurityError&&[400,401,403,413].includes(error.status)?error.status:
   error instanceof BatchEvidenceRepositoryError&&['BATCH_EVIDENCE_VERSION_MISSING','BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING'].includes(error.code)?409:503;
  const code=status===409?(error as BatchEvidenceRepositoryError).code:status===403?'BATCH_EVIDENCE_BILLING_PEER_REQUIRED':'BATCH_EVIDENCE_UNAVAILABLE';
  const res=host.switchToHttp().getResponse();res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(status).json({code});
 }
}
@Controller('internal/b2b')
@UseFilters(BatchMemberEvidenceFilter)
export class BatchMemberEvidenceController{
 constructor(@Inject(CORE)private readonly core:BatchMemberEvidence|PersistentBatchMemberEvidence,
  @Inject(PEERS)private readonly peers:readonly string[],@Inject(CLOCK)private readonly now:()=>string){}
 @Post('batch-member-evidence-status')async status(@Req()req:any,@Res()res:any){
  b2bPrivatePeer(req,this.peers);
  const names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase());
  if(!(this.core instanceof PersistentBatchMemberEvidence)||req.url!=='/internal/b2b/batch-member-evidence-status'||new Set(names).size!==names.length||
   req.headers.authorization||req.headers['transfer-encoding']||req.headers['content-encoding']||
   !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||
   !/^[1-9][0-9]{0,3}$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>2048||
   !req.body||Object.keys(req.body).sort().join(',')!=='asOf,requestId'||typeof req.body.requestId!=='string'||
   !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(req.body.requestId))throw new B2bSecurityError(400,'BATCH_EVIDENCE_INPUT_INVALID');
  const before=this.now();try{evidenceFresh(req.body.asOf,before);}catch{throw new B2bSecurityError(400,'BATCH_EVIDENCE_INPUT_INVALID');}
  const status=await this.core.readiness(),after=this.now();evidenceFresh(before,after);evidenceFresh(req.body.asOf,after);
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  return res.status(200).json({...status,requestId:req.body.requestId,asOf:req.body.asOf,verifiedAt:after});
 }
 @Post('batch-member-evidence')async verify(@Req()req:any,@Res()res:any){
  b2bPrivatePeer(req,this.peers);
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase());
  if(req.url!=='/internal/b2b/batch-member-evidence'||new Set(names).size!==names.length||req.headers.authorization||req.headers['transfer-encoding']||
   req.headers['content-encoding']||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||
   !/^[1-9][0-9]{0,3}$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>batchEvidenceLimits.request)
   throw new B2bSecurityError(400,'BATCH_EVIDENCE_INPUT_INVALID');
  const before=this.now();let request;
  try{request=batchEvidenceRequest(req.body,before);}catch{throw new B2bSecurityError(400,'BATCH_EVIDENCE_INPUT_INVALID');}
  const result=await this.core.verifySignedVersion(request.ownerHandle,request.asOf),after=this.now();
  evidenceFresh(before,after);return res.status(200).json(batchEvidenceResponse(request,result,after));
 }
}
@Module({})
export class BatchMemberEvidenceModule{
 static isolated(core:BatchMemberEvidence|PersistentBatchMemberEvidence,roles:{billing:readonly string[]},now:()=>string=()=>new Date().toISOString()):DynamicModule{
  evidenceRequire((core instanceof BatchMemberEvidence||core instanceof PersistentBatchMemberEvidence)&&roles&&Object.keys(roles).join(',')==='billing'&&
   Array.isArray(roles.billing)&&roles.billing.length>0&&roles.billing.length<=32&&new Set(roles.billing).size===roles.billing.length&&
   roles.billing.every(p=>typeof p==='string'&&/^[a-f0-9]{64}$/.test(p))&&typeof now==='function');
  return {module:BatchMemberEvidenceModule,controllers:[BatchMemberEvidenceController],providers:[BatchMemberEvidenceFilter,
   {provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...roles.billing])},{provide:CLOCK,useValue:now}]};
 }
}

