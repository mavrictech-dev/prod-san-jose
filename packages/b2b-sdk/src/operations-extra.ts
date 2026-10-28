import {createHash} from 'node:crypto';
import {BoundedTransport} from './transport';
import * as w from './validation';
import * as v from './operations-extra-validation';
import type {ReceivedScope} from './types';
import type {BusinessBinding,WriteOptions} from './phase8-types';
import type {ReceptionOptions,ReceptionConfigurationOptions,ReceptionWriteOptions,ReceptionConfigurationWriteOptions,ReceptionConfigurationSave,ReceptionConfiguration,ReceptionSyncCreate,ReceptionSyncCreated,ReceptionSyncResponse,HistoryQuery,HistoryPage,HistoricalDocument,HistoricalArtifactKind,HistoricalDownload,DocumentEmailRequest,EmailDelivery} from './operations-extra-types';

/** Nine explicit operations; all network access stays inside the pinned Node transport. */
export class ExtraOperationMethods {
  #extraTransport:BoundedTransport;
  constructor(transport:BoundedTransport){this.#extraTransport=transport;}
  async readReceptionConfiguration(scope:ReceivedScope,options:ReceptionConfigurationOptions):Promise<ReceptionConfiguration>{
    const a=v.data({scope,options});const extras=v.input(()=>{w.scope(a.scope);return v.options(a.options,false,true);});
    const r=await this.#extraTransport.json('receptionConfigRead',[String(a.scope.companyId)],scopeQuery(a.scope),undefined,undefined,extras);
    return v.response(()=>v.configuration(r,a.scope));
  }
  async saveReceptionConfiguration(scope:ReceivedScope,body:ReceptionConfigurationSave,options:ReceptionConfigurationWriteOptions):Promise<ReceptionConfiguration>{
    const a=v.data({scope,body,options});const extras=v.input(()=>{w.scope(a.scope);v.save(a.body,a.scope.recipientRuc);return v.options(a.options,true,true);});
    const r=await this.#extraTransport.json('receptionConfigSave',[String(a.scope.companyId)],scopeQuery(a.scope),a.body,a.options.idempotencyKey,extras);
    return v.response(()=>v.configuration(r,a.scope,a.body));
  }
  async createReceptionSync(scope:ReceivedScope,body:ReceptionSyncCreate,options:ReceptionWriteOptions):Promise<ReceptionSyncCreated>{
    const a=v.data({scope,body,options});const extras=v.input(()=>{w.scope(a.scope);v.sync(a.body);return v.options(a.options,true);});
    const r=await this.#extraTransport.json('receptionSyncCreate',[],scopeQuery(a.scope),a.body,a.options.idempotencyKey,extras);
    return v.response(()=>v.syncCreated(r,a.scope,a.body));
  }
  async readReceptionSync(scope:ReceivedScope,runId:string,options:ReceptionOptions={}):Promise<ReceptionSyncResponse>{
    const a=v.data({scope,runId,options});const extras=v.input(()=>{w.scope(a.scope);v.id(a.runId);return v.options(a.options);});
    const r=await this.#extraTransport.json('receptionSyncRead',[a.runId],scopeQuery(a.scope),undefined,undefined,extras);
    return v.response(()=>v.syncRead(r,a.scope,a.runId));
  }
  async listHistory(binding:BusinessBinding,query:HistoryQuery={}):Promise<HistoryPage>{
    const a=v.data({binding,query});const q=v.input(()=>{v.binding(a.binding);return v.historyQuery(a.query);});
    const r=await this.#extraTransport.json('historyList',[],{...v.bindingQuery(a.binding),...Object.fromEntries(Object.entries(q).map(([k,x])=>[k,String(x)]))});
    return v.response(()=>v.historyList(r,a.binding,q));
  }
  async readHistoricalDocument(binding:BusinessBinding,recordId:string):Promise<HistoricalDocument>{
    const a=v.data({binding,recordId});v.input(()=>{v.binding(a.binding);v.hash(a.recordId);});
    const r=await this.#extraTransport.json('historyDetail',[a.recordId],v.bindingQuery(a.binding));
    return v.response(()=>v.historyDetail(r,a.binding,a.recordId));
  }
  async downloadHistoricalArtifact(binding:BusinessBinding,recordId:string,kind:HistoricalArtifactKind):Promise<HistoricalDownload>{
    const a=v.data({binding,recordId,kind});v.input(()=>{v.binding(a.binding);v.hash(a.recordId);v.artifactKind(a.kind);});
    const before=await this.readHistoricalDocument(a.binding,a.recordId),metadata=before.data.snapshot.artifacts.find(x=>x.kind===a.kind);
    if(!metadata)v.fail('ARTIFACT_NOT_FOUND');
    const reply=await this.#extraTransport.file('historyContent',[a.recordId,a.kind],v.bindingQuery(a.binding),metadata.sizeBytes);
    const extension=metadata.kind.endsWith('_XML')?'xml':metadata.kind.startsWith('PDF_')?'pdf':'zip';
    const disposition=`attachment; filename="history.${extension}"; filename*=UTF-8''${encodeURIComponent(metadata.originalName).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`;
    if(reply.bytes.length!==metadata.sizeBytes||reply.headers['content-length']!==String(metadata.sizeBytes)||reply.headers['content-type']!==v.mediaType(a.kind)||reply.headers['x-content-sha256']!==metadata.sha256||reply.headers['content-disposition']!==disposition||createHash('sha256').update(reply.bytes).digest('hex')!==metadata.sha256)v.fail('ARTIFACT_INTEGRITY_FAILED');
    const after=await this.readHistoricalDocument(a.binding,a.recordId);
    if(!v.equal(before,after))v.fail('ARTIFACT_CHANGED');
    return {artifact:metadata,bytes:Buffer.from(reply.bytes)};
  }
  async requestDocumentEmail(binding:BusinessBinding,documentId:string,body:DocumentEmailRequest,options:WriteOptions):Promise<EmailDelivery>{
    const a=v.data({binding,documentId,body,options});v.input(()=>{v.binding(a.binding);v.id(a.documentId);v.emailRequest(a.body);v.fields(a.options,['idempotencyKey']);v.key(a.options.idempotencyKey);});
    const r=await this.#extraTransport.json('emailCreate',[a.documentId],{},{binding:a.binding,...a.body},a.options.idempotencyKey);
    return v.response(()=>v.email(r,{binding:a.binding,documentId:a.documentId,format:a.body.format}));
  }
  async readEmailDelivery(id:string):Promise<EmailDelivery>{
    const value=v.data(id);v.input(()=>v.id(value));const r=await this.#extraTransport.json('emailRead',[value],{});
    return v.response(()=>v.email(r,{id:value}));
  }
}
function scopeQuery(scope:ReceivedScope):Record<string,string>{return Object.fromEntries(Object.entries(scope).map(([k,x])=>[k,String(x)]));}

