import { Catch, HttpException, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IntegrationContractVersion } from '@factuez/contracts/integration';
import { IntegrationReadError } from './integration';
@Catch()
export class PrivateReadFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response=host.switchToHttp().getResponse();
    if (response.headersSent) { response.destroy(); return; }
    const safe=error instanceof IntegrationReadError ? error : error instanceof HttpException && error.getStatus()===404 ?
      new IntegrationReadError(404,'RESOURCE_NOT_FOUND') : error instanceof HttpException && [400,413].includes(error.getStatus()) ?
      new IntegrationReadError(400,'INVALID_REQUEST') : new IntegrationReadError(503,'UPSTREAM_UNAVAILABLE');
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    if (safe.status===401) response.setHeader('WWW-Authenticate','Bearer realm="factuez-integration"');
    if (safe.status===429) response.setHeader('Retry-After','60');
    response.status(safe.status).json({schemaVersion:IntegrationContractVersion,requestId:randomUUID(),
      error:{code:safe.code,message:safe.code,retryable:safe.status===503 || safe.status===429}});
  }
}
/** Bounded read-only listener. Identity's separate OAuth POST listener does not use this. */
export function privateReadBoundary(posts:Record<string,number>={},maximumActive=16) {
  if(!Number.isSafeInteger(maximumActive)||maximumActive<1||maximumActive>16)throw new Error('Bounded private concurrency required');
  let active=0;
  return (request:any,response:any,next:()=>void) => {
    privateHeaders(response);
    const fail=(status:number,code:string)=>{
      if(status===429) response.setHeader('Retry-After','60');
      response.status(status).json({schemaVersion:IntegrationContractVersion,requestId:randomUUID(),error:{code,message:code,retryable:status===429}});
    };
    const path=request.url.split('?')[0],maximum=posts[path];
    const read=request.method==='GET' && (request.headers['content-length']===undefined || request.headers['content-length']==='0');
    const post=request.method==='POST' && maximum && request.url===path && request.headers['content-type']==='application/json' &&
      /^[1-9][0-9]{0,7}$/.test(request.headers['content-length']??'') && Number(request.headers['content-length'])<=maximum;
    if ((!read&&!post) || request.url.length>8192 || request.headers['transfer-encoding']) return fail(400,'INVALID_REQUEST');
    if (active>=maximumActive) return fail(429,'RATE_LIMITED');
    active++;let released=false;const release=()=>{if(!released){released=true;active--;}};
    response.once('finish',release);response.once('close',release);next();
  };
}
export function privateHeaders(response: any) {
  response.setHeader('Cache-Control','private, no-store'); response.setHeader('X-Content-Type-Options','nosniff');
}
export function artifactResponse(response: any, file: {bytes:Buffer;sha256:string;fileName:string;mediaType:string}) {
  privateHeaders(response);
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !/^[A-Za-z0-9_-]{1,120}\.(xml|zip)$/.test(file.fileName) ||
    !['application/xml','application/zip'].includes(file.mediaType)) throw new IntegrationReadError(409,'INTEGRITY_FAILED');
  response.setHeader('Content-Type',file.mediaType); response.setHeader('Content-Length',file.bytes.length);
  response.setHeader('Content-Disposition','attachment; filename="'+file.fileName+'"');
  response.setHeader('X-Content-SHA256',file.sha256); response.setHeader('ETag','"'+file.sha256+'"');
  response.status(200).end(file.bytes);
}
