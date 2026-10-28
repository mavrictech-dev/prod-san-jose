import { B2bSecurityError,b2bBindingsContain,type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { b2bIssuerId,b2bQuery,b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
export interface B2bCommandOwner {execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<any>}
export class HttpB2bCommandOwner implements B2bCommandOwner {
  constructor(private readonly http:B2bPrivateHttp){}
  execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){return this.http.post('/internal/b2b/drafts',{kind,action,args},token);}
}
export class B2bCommands {
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:B2bCommandOwner,readonly issuanceConfigured=false){}
  async call(token:string,kind:'SERVICE'|'USER',action:'CREATE'|'PATCH'|'VALIDATE'|'CANCEL'|'ISSUE'|'READ'|'OPERATION',id:string|null,query:unknown,body?:unknown,key?:string,ifMatch?:string){
    const create=action==='CREATE',q=b2bQuery(query,create?[]:['issuerId','environment'],create?[]:['issuerId','environment']);
    if(!['SERVICE','USER'].includes(kind)||(id!==null&&!b2bUuid(id)))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const issuerId=create?(body as any)?.issuerId:b2bIssuerId(q.issuerId);
    if(!Number.isSafeInteger(issuerId)||issuerId<1)throw new B2bSecurityError(400,'INVALID_ISSUER');
    const frame=new B2bOwnerReadFrame(this.identity,kind),required:B2bIdentityScope[]=action==='OPERATION'?['b2b:operations:read']:action==='ISSUE'?['b2b:drafts:write','b2b:documents:issue']:['b2b:drafts:write'];
    const p=await frame.principal(token,required);if(!p.bindings.some(b=>b.issuerId===issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    if(action==='ISSUE'&&!this.issuanceConfigured)throw new B2bSecurityError(409,'PROFILE_NOT_ENABLED');
    const args=action==='READ'?{issuerId:String(issuerId),id}:action==='OPERATION'?{issuerId:String(issuerId),id,...(key?{key}:{})}:{issuerId:String(issuerId),id,key,...(ifMatch?{ifMatch}:{}),body};
    const value=await this.owner.execute(token,kind,action,args),context=value?.response?.context??value?.context??(action==='VALIDATE'?value?.operation?.context:null);
    if(!context||context.issuerId!==issuerId||!b2bBindingsContain(p.bindings,context))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
    await frame.principal(token,required);return value;
  }
}
