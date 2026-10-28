import 'reflect-metadata';
import { Catch, Controller, Get, Headers, Inject, Injectable, Module, Param, Query,
  ServiceUnavailableException, UnauthorizedException, StreamableFile, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HistoryError, historyJson, historyObject } from '@factuez/history-core';
import { HistoryReadAccessError } from './read-identity';
import type { HistoricalArchiveService } from './service';

export const HISTORY_READ_OPTIONS=Symbol('HISTORY_READ_OPTIONS');
export type HistoryReadApiOptions={enabled?:boolean;environment?:'BETA';datasetClass?:'SYNTHETIC';
  service?:Pick<HistoricalArchiveService,'list'|'detail'|'artifact'|'reconciliation'>};
const policy={environment:'BETA',datasetClass:'SYNTHETIC',fiscalAuthority:false,cdrAuthenticityVerified:false,
  transmission:false,countersChanged:false,readOnly:true};
function query(input:unknown,report=false){
  const q=historyJson(input),keys=Object.keys(q??{}),allowed=['issuerRuc','branchId','documentTypeCode','series',...(report?[]:['take','afterRecordId'])];
  if(keys.some(k=>!allowed.includes(k)))throw new HistoryReadAccessError(400,'HISTORY_QUERY_INVALID');
  historyObject(q,keys);
  const take=q.take??'25';
  if(typeof take!=='string'||!/^[1-9][0-9]{0,2}$/.test(take)||Number(take)>100)throw new HistoryReadAccessError(400,'HISTORY_QUERY_INVALID');
  return {issuerRuc:q.issuerRuc??null,branchId:q.branchId??null,documentTypeCode:q.documentTypeCode??null,
    series:q.series??null,take:report?100:Number(take),afterRecordId:q.afterRecordId??null};
}

@Controller('api/v1/history')
export class HistoryReadController{
  constructor(@Inject(HISTORY_READ_OPTIONS)private readonly options:HistoryReadApiOptions){}
  private read(authorization:unknown){
    if(!this.options.enabled||!this.options.service)throw new ServiceUnavailableException();
    if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(authorization))throw new UnauthorizedException();
    return {service:this.options.service,token:authorization.slice(7)};
  }
  @Get('documents')
  async documents(@Headers('authorization')authorization:unknown,@Query()input:unknown){
    const{service,token}=this.read(authorization),q=query(input),items=await service.list(q,token);
    return {schemaVersion:'factuez.history-read.v1',...policy,items,nextCursor:items.length===q.take?items.at(-1)?.recordId??null:null};
  }
  @Get('reconciliation')
  async reconciliation(@Headers('authorization')authorization:unknown,@Query()input:unknown){
    const{service,token}=this.read(authorization);return service.reconciliation(query(input,true),token);
  }
  @Get('documents/:recordId')
  async detail(@Headers('authorization')authorization:unknown,@Param('recordId')recordId:string){
    const{service,token}=this.read(authorization),{artifactKeys,...record}=await service.detail(recordId,token);
    return {schemaVersion:'factuez.history-read.v1',...policy,...record};
  }
  @Get('documents/:recordId/artifacts/:kind')
  async artifact(@Headers('authorization')authorization:unknown,@Param('recordId')recordId:string,@Param('kind')kind:string){
    const{service,token}=this.read(authorization),file=await service.artifact(recordId,kind,token);
    const filename=encodeURIComponent(file.originalName).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return new StreamableFile(file.bytes,{type:'application/octet-stream',length:file.bytes.length,
      disposition:`attachment; filename*=UTF-8''${filename}`});
  }
}
@Controller('health')
class HistoryReadHealthController{
  constructor(@Inject(HISTORY_READ_OPTIONS)private readonly options:HistoryReadApiOptions){}
  @Get()health(){return {status:this.options.enabled?'configured':'disabled',...policy};} // Liveness, not DB readiness.
}
@Catch()
@Injectable()
class HistoryReadExceptionFilter implements ExceptionFilter{
  catch(error:unknown,host:ArgumentsHost){
    let status=503,code='HISTORY_UNAVAILABLE';
    if(error instanceof HistoryReadAccessError){status=error.status;code=error.code;}
    else if(error instanceof HistoryError){
      if(error.code==='HISTORY_NOT_FOUND'||error.code==='ARTIFACT_NOT_FOUND'){status=404;code='HISTORY_NOT_FOUND';}
      else if(error.code==='PERMISSION_DENIED'||error.code.endsWith('_SCOPE_DENIED')){status=403;code='HISTORY_PERMISSION_DENIED';}
      else if(error.code.startsWith('INVALID_')||['JSON_LIMIT','RECONCILIATION_LIMIT','RECONCILIATION_CURSOR_NOT_ALLOWED'].includes(error.code)){status=400;code='HISTORY_REQUEST_INVALID';}
    }else if(error instanceof HttpException){
      const candidate=error.getStatus();
      if([400,401,403,404,413,415].includes(candidate)){status=candidate;code=candidate===401?'HISTORY_SESSION_REQUIRED':candidate===404?'HISTORY_NOT_FOUND':'HISTORY_REQUEST_INVALID';}
    }
    host.switchToHttp().getResponse().status(status).json({statusCode:status,code});
  }
}

/** No environment/secrets/DB reads or automatic listen. Disabled by default.
 * Enabled composition remains BETA+SYNTHETIC and has NO mutation routes.
 */
export async function createHistoryReadApp(options:HistoryReadApiOptions={}){
  if(options.enabled===true&&(options.environment!=='BETA'||options.datasetClass!=='SYNTHETIC'||!options.service))
    throw new HistoryReadAccessError(503,'HISTORY_SYNTHETIC_PROFILE_REQUIRED');
  const config=Object.freeze({...options,enabled:options.enabled===true});
  @Module({controllers:[HistoryReadController,HistoryReadHealthController],providers:[{provide:HISTORY_READ_OPTIONS,useValue:config}]})
  class HistoryReadModule{}
  const app=await NestFactory.create(HistoryReadModule,{logger:false,bodyParser:false});
  app.getHttpAdapter().getInstance().set('query parser','simple');
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req:unknown,res:{setHeader:(key:string,value:string)=>void},next:()=>void)=>{
    res.setHeader('Cache-Control','private, no-store');res.setHeader('Pragma','no-cache');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");next();
  });
  app.useGlobalFilters(new HistoryReadExceptionFilter());await app.init();return app;
}
