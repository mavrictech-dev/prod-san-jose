import { createHash } from 'node:crypto';
import { B2bSecurityError,type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
export interface B2bExportPort {call(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<any>}
export class HttpB2bExportPort implements B2bExportPort {
  constructor(private readonly http:B2bPrivateHttp){}
  call(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){return action==='content'?this.http.exportFile({kind,action,args},token):this.http.post('/internal/b2b/exports',{kind,action,args},token);}
}
export class B2bExports {
  private active=0;
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:B2bExportPort){}
  async call(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){
    if(this.active>=2)throw new B2bSecurityError(429,'RATE_LIMITED');this.active++;
    try{
      const frame=new B2bOwnerReadFrame(this.identity,kind),scopes:B2bIdentityScope[]=action==='changes'?['b2b:documents:read','b2b:changes:read']:action==='create'?['b2b:documents:read','b2b:exports:create']:['documents','detail'].includes(action)?['b2b:documents:read']:['b2b:documents:read','b2b:exports:read'];
      await frame.principal(token,scopes);const value=await this.owner.call(token,kind,action,args);await frame.principal(token,scopes);
      if(action==='content'){
        if(!Buffer.isBuffer(value?.bytes)||!value.bytes.length||value.bytes.length>64*1024*1024||value.mediaType!=='application/zip'||!/^factuez-export-[a-f0-9-]{36}\.zip$/.test(value.fileName)||createHash('sha256').update(value.bytes).digest('hex')!==value.sha256)throw new B2bSecurityError(409,'INTEGRITY_FAILED');
      }else if(value?.schemaVersion!=='factuez.b2b.v1'||value?.payloadContract!=='factuez.integration.v1'||!value.payload)throw new B2bSecurityError(503,'INVALID_OWNER_RESPONSE');
      return value;
    }finally{this.active--;}
  }
}
