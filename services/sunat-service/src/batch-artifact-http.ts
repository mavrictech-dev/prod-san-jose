import {Catch,Controller,Inject,Module,Post,Req,Res,UseFilters,type ArgumentsHost,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {BATCH_ARTIFACT_KINDS,batchArtifactScope} from '@factuez/service-access/dist/b2b-batch-artifact-wire';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {BatchLocalArtifactError} from './application/batch-local-artifacts';
import {BatchArtifactApi} from './application/batch-artifact-api';
const CORE=Symbol('Batch artifact core'),PEERS=Symbol('Batch artifact peers');
@Catch()
export class BatchArtifactHttpFilter{
  catch(error:unknown,host:ArgumentsHost){
    let status=503;
    if(error instanceof B2bSecurityError&&[400,401,403,404,409,413,429].includes(error.status))status=error.status;
    if(error instanceof BatchLocalArtifactError){if(['NOT_PREPARED','CDR_NOT_FOUND'].includes(error.code))status=404;
      else if(['OWNER_CHANGED','CDR_CONFLICT','IDENTITY_CONFLICT','INTEGRITY_FAILED'].includes(error.code))status=409;}
    const res=host.switchToHttp().getResponse();res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    return res.status(status).json({code:status===401?'INVALID_TOKEN':status===403?'PRIVATE_ACCESS_DENIED':status===404?'BATCH_ARTIFACT_NOT_FOUND':status===400?'INVALID_BATCH_ARTIFACT_REQUEST':'BATCH_ARTIFACT_UNAVAILABLE'});
  }
}
@Controller('internal/b2b')
@UseFilters(BatchArtifactHttpFilter)
export class BatchArtifactController{
  constructor(@Inject(CORE)private readonly core:BatchArtifactApi,@Inject(PEERS)private readonly peers:readonly string[]){}
  @Post('batch-artifacts')
  async execute(@Req()req:any,@Res()res:any){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(req,this.peers);
    const auth=req.headers.authorization,names:string[]=(req.rawHeaders??[]).filter((_v:string,i:number)=>i%2===0).map((n:string)=>n.toLowerCase());
    if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth)||names.filter(n=>n==='authorization').length!==1)throw new B2bSecurityError(401,'INVALID_TOKEN');
    if(new Set(names).size!==names.length||req.url.includes('?')||Object.keys(req.query??{}).length)throw new B2bSecurityError(400,'INVALID_BATCH_ARTIFACT_REQUEST');
    const b:any=correctionEvidenceFreeze(req.body);
    if(!b||Buffer.byteLength(JSON.stringify(b))>32768||!['SERVICE','USER'].includes(b.kind)||!['PREPARE','READ','CONTENT'].includes(b.action)||
      Object.keys(b).sort().join(',')!==(b.action==='CONTENT'?'action,artifact,kind,scope':'action,kind,scope')||
      b.action==='CONTENT'&&!BATCH_ARTIFACT_KINDS.includes(b.artifact))throw new B2bSecurityError(400,'INVALID_BATCH_ARTIFACT_REQUEST');
    const scope=batchArtifactScope(b.scope),access={token:auth.slice(7),kind:b.kind};
    if(b.action!=='CONTENT')return res.status(200).json(await this.core.view(scope,access,b.action==='PREPARE'));
    const file=await this.core.content(scope,access,b.artifact);res.setHeader('Content-Type',file.mediaType);res.setHeader('Content-Length',String(file.bytes.length));
    res.setHeader('Content-Disposition',`attachment; filename="${file.fileName}"`);res.setHeader('X-Content-Sha256',file.sha256);
    res.setHeader('X-FactuEz-Source','LOCAL_EMULATOR');return res.status(200).send(file.bytes);
  }
}
@Module({})
export class BatchArtifactModule{
  static isolated(core:BatchArtifactApi,peers:readonly string[]):DynamicModule{
    if(!core||typeof core.view!=='function'||typeof core.content!=='function'||!Array.isArray(peers)||!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))
      throw new Error('EXPLICIT_BATCH_ARTIFACT_OWNER_AND_PEERS_REQUIRED');
    return {module:BatchArtifactModule,controllers:[BatchArtifactController],providers:[BatchArtifactHttpFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
  }
}
