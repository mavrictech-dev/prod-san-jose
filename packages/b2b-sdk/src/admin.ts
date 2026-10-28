import {inspect} from 'node:util';
import {BoundedTransport,type FactuEzB2bAdminOptions} from './transport';
import * as v from './phase8-validation';
import type {ApplicationCreate,ApplicationUpdate,AdminResponse,AdminSecretResponse,ApplicationPage} from './phase8-types';
/** Independent human-admin transport. It has no operational bearer, PWA session or token cache. */
export class FactuEzB2bAdminClient {
  #transport:BoundedTransport;
  constructor(options:FactuEzB2bAdminOptions){this.#transport=new BoundedTransport(options,true);}
  toJSON(){return {sdk:'FactuEzB2bAdminClient',environment:'BETA'};}
  [inspect.custom](){return 'FactuEzB2bAdminClient { environment: BETA, credentials: [PRIVATE] }';}
  async listApplications(query:{limit?:number;after?:string}={}):Promise<ApplicationPage>{
    const q=v.data(query);v.input(()=>{v.fields(q,['limit','after'],[]);if(q.limit!==undefined&&!v.integer(q.limit,1,50))v.fail();if(q.after!==undefined)v.id(q.after);});const limit=q.limit??25;
    const reply=await this.#transport.json('adminList',[],{environment:'BETA',limit:String(limit),...(q.after?{after:q.after}:{})});
    return v.admin(reply,'list',{limit,after:q.after}) as unknown as ApplicationPage;
  }
  async readApplication(id:string):Promise<AdminResponse>{v.input(()=>v.id(id));return v.admin(await this.#transport.json('adminRead',[id],{environment:'BETA'}),'read',{id}) as unknown as AdminResponse;}
  async createApplication(body:ApplicationCreate):Promise<AdminSecretResponse>{const b=v.data(body);v.input(()=>v.adminBody(b,'create'));return v.admin(await this.#transport.json('adminCreate',[],{environment:'BETA'},b),'create',{body:b}) as unknown as AdminSecretResponse;}
  async updateApplication(id:string,body:ApplicationUpdate):Promise<AdminResponse>{const b=v.data(body);v.input(()=>{v.id(id);v.adminBody(b,'update');});return v.admin(await this.#transport.json('adminUpdate',[id],{environment:'BETA'},b),'update',{id,body:b}) as unknown as AdminResponse;}
  async rotateApplicationSecret(id:string,body:{expectedRevision:number}):Promise<AdminSecretResponse>{const b=v.data(body);v.input(()=>{v.id(id);v.adminBody(b,'rotate');});return v.admin(await this.#transport.json('adminRotate',[id],{environment:'BETA'},b),'rotate',{id,body:b}) as unknown as AdminSecretResponse;}
}
