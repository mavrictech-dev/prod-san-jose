import {createHash} from 'node:crypto';
import {BoundedTransport,type Operation} from './transport';
import {ExtraOperationMethods} from './operations-extra';
import * as w from './validation';
import * as v from './phase8-validation';
import type {ReceivedScope} from './types';
import type {BusinessBinding,BusinessQuery,CustomerBody,ProductBody,BusinessCustomer,BusinessProduct,BusinessShift,BusinessSummary,BusinessResponse,WriteOptions,RevisionWriteOptions,OpenShiftBody,CloseShiftBody,CashMovementBody,ReceivedUpload,ReceivedAttachment,ReceivedAssignment,ReceivedRegistration,ReceivedCommandResponse,ReportFilters,ReportFormat,ReportDashboard,ReportJob,ReportResponse,ReportCreated,ReportDownload} from './phase8-types';
/** Internal implementation inherited by the public client; no generic dispatch surface. */
export class Phase8Methods extends ExtraOperationMethods {
  #transport:BoundedTransport;
  constructor(transport:BoundedTransport){super(transport);this.#transport=transport;}
  async #business<T>(op:Operation,binding:BusinessBinding,kind:'customer'|'product'|'shift'|'summary',args:{query?:BusinessQuery;id?:string;body?:Record<string,any>;options?:WriteOptions|RevisionWriteOptions;state?:'OPEN'|'CLOSED'}={}):Promise<BusinessResponse<T>>{
    const [b,a]=v.data([binding,args]);v.input(()=>v.binding(b));
    const ids=a.id===undefined?[]:[a.id];v.input(()=>ids.forEach(v.id));
    let body=a.body,key:string|undefined,expectedRevision:number|undefined;let q:ReturnType<typeof v.list>|undefined;
    v.input(()=>{
      if(a.query!==undefined)q=v.list(a.query);
      if(a.options!==undefined){const cas=['customerUpdate','productUpdate','shiftClose','cash'].includes(op);v.write(a.options,cas);key=a.options.idempotencyKey;expectedRevision=(a.options as RevisionWriteOptions).expectedRevision;}
      if(body!==undefined){
        if(kind==='customer')v.customer(body,op==='customerUpdate');
        else if(kind==='product')v.product(body,op==='productUpdate');
        else if(op==='shiftOpen'){v.fields(body,['openingAmount','currency']);v.amount(body.openingAmount);if(!['PEN','USD'].includes(body.currency))v.fail();}
        else if(op==='shiftClose'){v.fields(body,['countedAmount','reason']);v.amount(body.countedAmount);v.text(body.reason,300);}
        else{v.fields(body,['direction','amount','reason']);if(!['IN','OUT'].includes(body.direction))v.fail();v.amount(body.amount,2,false,true);v.text(body.reason,300);}
      }
    });
    const wireBody=expectedRevision===undefined?body:['customerUpdate','productUpdate'].includes(op)?{body,expectedRevision}:{...body,expectedRevision};
    const query={...v.bindingQuery(b),...Object.fromEntries(Object.entries(q??{}).map(([k,x])=>[k,String(x)]))};
    const reply=await this.#transport.json(op,ids,query,wireBody,key);
    const checkBody=kind==='shift'?op==='shiftOpen'||op==='shiftClose'?Object.fromEntries(Object.entries(body??{}).filter(([k])=>k!=='reason')):undefined:body;
    return v.business(reply,b,kind,{list:q,write:key!==undefined,id:a.id,revision:expectedRevision===undefined?key?1:undefined:expectedRevision+1,body:checkBody,state:a.state}) as unknown as BusinessResponse<T>;
  }
  listCustomers(binding:BusinessBinding,query:BusinessQuery={}){return this.#business<BusinessCustomer[]>('customers',binding,'customer',{query});}
  readCustomer(binding:BusinessBinding,id:string){return this.#business<BusinessCustomer>('customer',binding,'customer',{id});}
  createCustomer(binding:BusinessBinding,body:CustomerBody,options:WriteOptions){return this.#business<BusinessCustomer>('customerCreate',binding,'customer',{body,options});}
  updateCustomer(binding:BusinessBinding,id:string,body:Partial<CustomerBody>,options:RevisionWriteOptions){return this.#business<BusinessCustomer>('customerUpdate',binding,'customer',{id,body,options});}
  listBusinessProducts(binding:BusinessBinding,query:BusinessQuery={}){return this.#business<BusinessProduct[]>('products',binding,'product',{query});}
  createProduct(binding:BusinessBinding,body:ProductBody,options:WriteOptions){return this.#business<BusinessProduct>('productCreate',binding,'product',{body,options});}
  updateProduct(binding:BusinessBinding,id:string,body:Partial<ProductBody>,options:RevisionWriteOptions){return this.#business<BusinessProduct>('productUpdate',binding,'product',{id,body,options});}
  listShifts(binding:BusinessBinding,query:BusinessQuery={}){return this.#business<BusinessShift[]>('shifts',binding,'shift',{query});}
  openShift(binding:BusinessBinding,body:OpenShiftBody,options:WriteOptions){return this.#business<BusinessShift>('shiftOpen',binding,'shift',{body,options,state:'OPEN'});}
  closeShift(binding:BusinessBinding,id:string,body:CloseShiftBody,options:RevisionWriteOptions){return this.#business<BusinessShift>('shiftClose',binding,'shift',{id,body,options,state:'CLOSED'});}
  createCashMovement(binding:BusinessBinding,id:string,body:CashMovementBody,options:RevisionWriteOptions){return this.#business<BusinessShift>('cash',binding,'shift',{id,body,options,state:'OPEN'});}
  businessSummary(binding:BusinessBinding){return this.#business<BusinessSummary>('summary',binding,'summary');}
  async #received<A extends 'IMPORT'|'ATTACH'|'ASSIGN'|'REGISTER'>(action:A,scope:ReceivedScope,body:ReceivedUpload|ReceivedAttachment|ReceivedAssignment|ReceivedRegistration,options:WriteOptions,id?:string):Promise<ReceivedCommandResponse<A>>{
    const s=v.data(scope),o=v.data(options);const b:any=v.data(body);v.input(()=>{w.scope(s);v.write(o,false,128);if(id!==undefined)v.id(id);
      if(action==='IMPORT')v.upload(b,'xml');
      else if(action==='ATTACH'){v.fields(b,['kind','file']);if(!['CDR','PROVIDER_PDF'].includes(b.kind))v.fail();v.upload(b.file,b.kind==='CDR'?'xml':'pdf');}
      else if(action==='ASSIGN'){v.fields(b,['targetBranchId','expectedXmlSha256']);v.id(b.targetBranchId);if(b.targetBranchId===s.branchId||!v.hash(b.expectedXmlSha256))v.fail();}
      else{v.fields(b,['registeredAt','erpReference','expectedErpReference']);if(b.registeredAt!==null)v.instant(b.registeredAt);v.reference(b.erpReference);v.reference(b.expectedErpReference);}
    });
    const op={IMPORT:'receivedImport',ATTACH:'receivedAttach',ASSIGN:'receivedAssign',REGISTER:'receivedRegister'} as const;
    const query=Object.fromEntries(Object.entries(s).map(([k,x])=>[k,String(x)]));
    const reply=await this.#transport.json(op[action],id?[id]:[],query,b,o.idempotencyKey);
    return v.command(reply,s,action,id,action==='ASSIGN'?(b as ReceivedAssignment).targetBranchId:undefined) as unknown as ReceivedCommandResponse<A>;
  }
  receivedImportXML(scope:ReceivedScope,file:ReceivedUpload,options:WriteOptions){return this.#received('IMPORT',scope,file,options);}
  receivedAttach(scope:ReceivedScope,id:string,body:ReceivedAttachment,options:WriteOptions){return this.#received('ATTACH',scope,body,options,id);}
  receivedAssign(scope:ReceivedScope,id:string,body:ReceivedAssignment,options:WriteOptions){return this.#received('ASSIGN',scope,body,options,id);}
  receivedRegister(scope:ReceivedScope,id:string,body:ReceivedRegistration,options:WriteOptions){return this.#received('REGISTER',scope,body,options,id);}
  async dashboard(filters:ReportFilters):Promise<ReportResponse<ReportDashboard>>{
    const f=v.input(()=>v.filters(v.data(filters))),q=v.filterQuery(f);
    return v.report(await this.#transport.json('dashboard',[],q),'dashboard',{filters:f}) as unknown as ReportResponse<ReportDashboard>;
  }
  async createReport(filters:ReportFilters,format:ReportFormat,options:WriteOptions):Promise<ReportCreated>{
    const f=v.input(()=>v.filters(v.data(filters))),o=v.data(options);v.input(()=>{v.write(o);if(!Object.hasOwn(v.mime,format))v.fail();});
    return v.report(await this.#transport.json('reportCreate',[],{environment:'BETA'},{filters:v.filterQuery(f),format},o.idempotencyKey),'create',{format}) as unknown as ReportCreated;
  }
  async readReport(id:string):Promise<ReportResponse<ReportJob>>{v.input(()=>v.id(id));return v.report(await this.#transport.json('reportRead',[id],{environment:'BETA'}),'read',{id}) as unknown as ReportResponse<ReportJob>;}
  async downloadReport(id:string):Promise<ReportDownload>{
    v.input(()=>v.id(id));const before=await this.readReport(id),m=before.data.content;
    if(before.data.state!=='READY'||!m)v.fail('ARTIFACT_NOT_FOUND');
    const reply=await this.#transport.file('reportContent',[id],{environment:'BETA'},m.sizeBytes);
    if(reply.bytes.length!==m.sizeBytes||reply.headers['content-length']!==String(m.sizeBytes)||reply.headers['content-type']!==m.mediaType||reply.headers['x-content-sha256']!==m.sha256||reply.headers['content-disposition']!==`attachment; filename="${m.fileName}"`||createHash('sha256').update(reply.bytes).digest('hex')!==m.sha256)v.fail('ARTIFACT_INTEGRITY_FAILED');
    const after=await this.readReport(id);if(!v.equal(before,after))v.fail('ARTIFACT_CHANGED');
    return {report:before.data,bytes:Buffer.from(reply.bytes)};
  }
}
