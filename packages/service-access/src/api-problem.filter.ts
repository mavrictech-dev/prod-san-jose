import {Catch,HttpException,Logger,type ArgumentsHost,type ExceptionFilter} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {apiProblem,type ApiFieldIssue} from '@factuez/contracts';
import {ProductionError} from './b2b-production-contract';
@Catch()
export class ApiProblemFilter implements ExceptionFilter {
 private readonly logger=new Logger(ApiProblemFilter.name);
 catch(error:unknown,host:ArgumentsHost){
  const http=host.switchToHttp(),request=http.getRequest(),response=http.getResponse();
  if(response.headersSent){response.destroy?.();return;}
  const known=error instanceof HttpException||error instanceof ProductionError;
  const status=error instanceof HttpException?error.getStatus():error instanceof ProductionError?error.status:500;
  const raw=error instanceof HttpException?error.getResponse():undefined;
  const body=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
  const baseCode=({400:'INVALID_REQUEST',401:'AUTHENTICATION_REQUIRED',403:'ACCESS_DENIED',404:'RESOURCE_NOT_FOUND',409:'STATE_CONFLICT',413:'BODY_TOO_LARGE',415:'INVALID_CONTENT_TYPE',422:'VALIDATION_FAILED',429:'RATE_LIMITED',503:'SERVICE_UNAVAILABLE'} as Record<number,string>)[status]??'INTERNAL_ERROR';
  const code=error instanceof ProductionError?error.code:typeof body.code==='string'&&/^[A-Za-z0-9_]{1,100}$/.test(body.code)?body.code:baseCode;
  let message=typeof raw==='string'?raw:Array.isArray(body.message)?body.message.filter(v=>typeof v==='string').join('; '):typeof body.message==='string'?body.message:undefined;
  if(!known||status===500||message&&/-----BEGIN|postgres(?:ql)?:\/\/|Bearer\s+[A-Za-z0-9._-]{20,}|client_secret\s*[:=]|password\s*[:=]/i.test(message))message=undefined;
  if(message)message=message.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,3000);
  const errors=Array.isArray(body.errors)?body.errors.filter((v):v is ApiFieldIssue=>!!v&&typeof v==='object'&&typeof v.field==='string'&&v.field.length<=160&&typeof v.code==='string'&&v.code.length<=100&&typeof v.message==='string'&&v.message.length<=600):[];
  const fieldErrors=body.fieldErrors&&typeof body.fieldErrors==='object'&&!Array.isArray(body.fieldErrors)?Object.fromEntries(Object.entries(body.fieldErrors).filter(([,v])=>typeof v==='string')) as Record<string,string>:undefined;
  const proposed=request.headers?.['x-correlation-id'];const requestId=typeof proposed==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(proposed)?proposed:randomUUID();
  response.setHeader('Cache-Control','private, no-store');response.setHeader('X-Correlation-Id',requestId);response.setHeader('X-Content-Type-Options','nosniff');
  if(status===429)response.setHeader('Retry-After','60');
  this.logger.warn(JSON.stringify({requestId,status,code,method:String(request.method??'').slice(0,10),route:typeof request.route?.path==='string'?request.route.path:undefined,exception:error instanceof Error?error.constructor.name:'UnknownError'}));
  const details=typeof body.operationId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.operationId)&&['PENDING','REJECTED','UNCERTAIN'].includes(String(body.operationState))?{operationId:body.operationId,operationState:body.operationState}:{};
  const problem={...apiProblem({status,code,message,requestId,errors,fieldErrors}),...details};
  const oauth=String(request.originalUrl??request.url??'').split('?')[0]==='/b2b/oauth/token';
  if(status===401)response.setHeader('WWW-Authenticate',oauth?'Basic realm="FactuEz B2B"':'Bearer realm="FactuEz"');
  response.status(status).json(oauth?{...problem,error:['invalid_request','invalid_client','invalid_scope','unsupported_grant_type','temporarily_unavailable'].includes(code)?code:status>=500?'server_error':'invalid_request',error_description:problem.message}:problem);
 }
}
