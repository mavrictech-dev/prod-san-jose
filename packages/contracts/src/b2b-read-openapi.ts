/** Candidate read listener only. No write routes, deployments or tax acceptance implied. */
import { B2bAudience,B2bContractVersion } from './b2b';
import { integrationOpenApiV1 } from './integration-openapi';
import { b2bDesignOpenApiV1 } from './b2b-openapi';
import {addB2bWebhookRoutes} from './b2b-webhook-openapi';
import {addB2bCommercialRoutes} from './b2b-commercial-openapi';
import {addB2bCorrectionRoutes} from './b2b-correction-openapi';
import {addB2bGuideDraftRoutes} from './b2b-guide-openapi';
import {addB2bGuideIssueOpenApi} from './b2b-guide-issue-openapi';
import {addB2bGuideArtifactOpenApi} from './b2b-guide-artifact-openapi';
import {addB2bPhase7OpenApi} from './b2b-phase7-openapi';
import {addB2bReceivedOpenApi} from './b2b-received-openapi';
import {addB2bPhase8OpenApi} from './b2b-phase8-openapi';
import {addB2bPhase8ExtraOpenApi} from './b2b-phase8-extra-openapi';
type S=Record<string,any>;
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const text=(maxLength=300)=>({type:'string',maxLength});
const val=(values:readonly string[])=>({type:'string',enum:[...values]});
const obj=(properties:S,optional:string[]=[])=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties).filter(k=>!optional.includes(k))});
const nullable=(s:S)=>({anyOf:[s,{type:'null'}]});
const array=(items:S,maxItems=100)=>({type:'array',items,maxItems});
const uuid={type:'string',format:'uuid'},issuerId={type:'integer',minimum:1},beta={type:'string',const:'BETA'},version={type:'string',const:B2bContractVersion};
export function b2bReadOpenApiV1():S{
  const old=(integrationOpenApiV1() as any).components.schemas;
  const schemas:S=Object.fromEntries(['Party','Tax','Allowance','Item','Totals','Reference','PaymentTerms','Sale','DocumentSource'].map(name=>[name,structuredClone(old[name])]));
  schemas.Context=obj({issuerId,issuerRuc:{type:'string',pattern:'^[0-9]{11}$'},environment:beta,branchId:uuid,pointId:uuid,seriesId:uuid,documentType:val(['01','03'])});
  schemas.State=obj({local:nullable(val(['ISSUED','CANCELLED'])),transport:nullable(old.DocumentState.properties.transport),fiscal:{type:'string',const:'NOT_VERIFIED'},provenance:old.DocumentState.properties.provenance});
  schemas.Document=obj({schemaVersion:version,id:uuid,context:ref('Context'),documentType:val(['01','03']),series:text(4),number:{type:'string',pattern:'^[0-9]{1,18}$'},fullNumber:text(32),resourceVersion:text(100),snapshotSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},issuerName:nullable(text(500)),issueDate:{type:'string',format:'date'},issueTime:old.DocumentRow.properties.issueTime,currency:nullable(val(['PEN','USD'])),customer:nullable(ref('Party')),payableAmount:old.DocumentRow.properties.payableAmount,detail:ref('Sale'),state:ref('State'),source:ref('DocumentSource'),warnings:array(text(120))});
  schemas.Status=obj({schemaVersion:version,documentId:uuid,...schemas.State.properties});
  schemas.Me=obj({schemaVersion:version,clientId:uuid,actor:{oneOf:[obj({kind:{type:'string',const:'SERVICE'}}),obj({kind:{type:'string',const:'USER'},subjectId:uuid})]},effectiveScopes:array(text(80)),grantRevision:text(100),environment:beta});
  schemas.Issuer=obj({id:issuerId,ruc:{type:'string',pattern:'^[0-9]{11}$'},legalName:text(500),environment:beta});
  schemas.Branch=obj({id:uuid,issuerId,code:text(30),name:text(300)});
  schemas.Point=obj({id:uuid,issuerId,branchId:uuid,code:text(30),name:text(300)});
  schemas.Series=obj({id:uuid,issuerId,branchId:uuid,pointId:uuid,type:val(['01','03']),label:text(4)});
  schemas.Product=obj({id:uuid,sku:text(100),description:text(500),unitCode:text(8),taxAffectationCode:text(4),defaultUnitPrice:nullable({type:'string',pattern:'^[0-9]+(?:\\.[0-9]+)?$'})});
  schemas.PageInfo=obj({limit:{type:'integer',minimum:1,maximum:100},nextCursor:nullable({type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}),snapshotId:uuid,snapshotAt:{type:'string',format:'date-time'},expiresAt:{type:'string',format:'date-time'},hasMore:{type:'boolean'},complete:{type:'boolean',description:'Fin de este corte autorizado, no cobertura universal de tipos.'}});
  schemas.Coverage=obj({documentTypes:{const:['01','03'],type:'array'},unsupported:{const:['07','08','09','31'],type:'array'},scope:{const:'AUTHORIZED_FILTERED_CUT',type:'string'},fiscalAcceptance:{const:'NOT_ASSERTED',type:'string'}});
  for(const name of ['Issuer','Branch','Point','Series','Product','Document'])schemas[name+'Page']=obj({schemaVersion:version,items:array(ref(name)),page:ref('PageInfo'),coverage:ref('Coverage')});
  schemas.Artifact=obj({id:uuid,kind:val(['UNSIGNED_XML','SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP']),owner:obj({kind:val(['DOCUMENT','BATCH']),id:uuid}),fileName:{type:'string',pattern:'^[A-Za-z0-9_-]{1,150}\\.(xml|zip)$'},mediaType:val(['application/xml','application/zip']),byteLength:{type:'integer',minimum:1,maximum:10485760},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},availability:{const:'AVAILABLE',type:'string'},representation:{const:'ORIGINAL',type:'string'},provenance:{const:'LOCAL',type:'string'},verification:obj({integrity:{const:'UNVERIFIED',type:'string'},signature:{const:'UNVERIFIED',type:'string'},trust:{const:'UNVERIFIED',type:'string'},identity:{const:'UNVERIFIED',type:'string'},checkedAt:{type:'null'}})});
  schemas.ArtifactList=obj({schemaVersion:version,items:array(ref('Artifact'),32),warnings:array(text(120))});
  schemas.Capabilities=obj({schemaVersion:version,environment:beta,fiscalActivation:{type:'boolean',const:false},executionReadiness:{const:'NOT_PROBED',type:'string'},features:array(obj({id:text(80),state:val(['ENABLED','DISABLED','NOT_IMPLEMENTED']),reason:text(300)})),coverage:array(obj({type:val(['01','03','07','08','09','31']),state:val(['SUPPORTED','SOURCE_NOT_SUPPORTED'])})),originalArtifacts:array(text(80)),localRepresentations:array(val(['a4','ticket'])),limits:obj({pageSize:{const:100,type:'integer'},cutRows:{const:10000,type:'integer'},cutTtlSeconds:{const:300,type:'integer'},dateRangeDays:{const:366,type:'integer'}}),legacyExtraction:obj({separateAudience:{const:true,type:'boolean'},forwarded:{const:false,type:'boolean'}})});
  schemas.Error=obj({schemaVersion:version,requestId:uuid,code:text(100),message:text(100),retryable:{type:'boolean'}});
  const paths:S={};
  const parameter=(name:string,required=false,schema:S=text(100))=>({name,in:'query',required,schema});
  const add=(path:string,id:string,response:string,scope:string[],options:{paged?:boolean;issuer?:boolean;dates?:boolean;lookup?:boolean;binary?:boolean;env?:boolean}={})=>{
    const parameters:S[]=[{name:'X-FactuEz-Actor-Kind',in:'header',required:false,schema:val(['SERVICE','USER'])}];
    for(const match of path.matchAll(/\{([^}]+)\}/g))parameters.push({name:match[1],in:'path',required:true,schema:match[1]==='format'?val(['a4','ticket']):uuid});
    if(options.env!==false)parameters.push(parameter('environment',true,beta));
    if(options.issuer)parameters.push(parameter('issuerId',true,issuerId));
    if(options.paged){parameters.push(parameter('limit',false,{type:'integer',minimum:1,maximum:100}),parameter('cursor'));if(!path.endsWith('/products')){if(!options.issuer)parameters.push(parameter('issuerId',false,issuerId));parameters.push(parameter('branchId',false,uuid),parameter('pointId',false,uuid));}}
    if(options.dates)parameters.push(parameter('from',true,{type:'string',format:'date'}),parameter('to',true,{type:'string',format:'date'}),parameter('types',false,{type:'string',description:'CSV 01,03; otros tipos devuelven 422, nunca se omiten.'}),parameter('seriesId',false,uuid));
    if(options.lookup)for(const key of ['type','series','number'])parameters.push(parameter(key,true));
    const success=options.binary?{description:'Bytes íntegros. PDF es representación local CURRENT-PRUEBA, no aceptación fiscal.',headers:{'Content-Length':{schema:{type:'integer'}},'X-Content-SHA256':{schema:{type:'string',pattern:'^[a-f0-9]{64}$'}},'Content-Disposition':{schema:text()}},content:Object.fromEntries((path.includes('representations')?['application/pdf']:['application/xml','application/zip']).map(mime=>[mime,{schema:{type:'string',format:'binary'}}]))}:{description:'Respuesta autorizada',content:{'application/json':{schema:ref(response)}}};
    paths[path]={get:{operationId:id,'x-source-implemented':true,'x-runtime-enabled':false,security:[{B2bBearer:[],PrivateTransport:[]}],'x-required-scopes':scope,parameters,responses:{'200':success,...Object.fromEntries([400,401,403,404,409,410,413,422,429,503].map(code=>[code,{description:'Error seguro, sin rutas ni secretos',content:{'application/json':{schema:ref('Error')}}}]))}}};
  };
  const base='/b2b/v1',catalog=['b2b:catalog:read'],docs=['b2b:documents:read'],artifacts=[...docs,'b2b:artifacts:read'];
  add(base+'/me','b2bMe','Me',['b2b:context:read'],{env:false});add(base+'/capabilities','b2bCapabilities','Capabilities',['b2b:context:read']);
  for(const [name,schema]of [['issuers','Issuer'],['branches','Branch'],['points','Point'],['series','Series'],['products','Product']])add(base+'/'+name,'b2bList'+schema,schema+'Page',catalog,{paged:true,issuer:!['issuers','products'].includes(name)});
  add(base+'/documents/lookup','b2bLookupDocument','Document',docs,{issuer:true,lookup:true});add(base+'/documents','b2bListDocuments','DocumentPage',docs,{issuer:true,paged:true,dates:true});
  add(base+'/documents/{id}','b2bGetDocument','Document',docs,{issuer:true});add(base+'/documents/{id}/status','b2bGetStatus','Status',docs,{issuer:true});
  add(base+'/documents/{id}/artifacts','b2bListArtifacts','ArtifactList',artifacts,{issuer:true});add(base+'/batches/{id}/artifacts','b2bListBatchArtifacts','ArtifactList',artifacts,{issuer:true});
  add(base+'/artifacts/{id}/content','b2bDownloadOriginal','',artifacts,{issuer:true,binary:true});add(base+'/documents/{id}/representations/{format}','b2bRenderCurrentLocal','',artifacts,{issuer:true,binary:true});
  return {openapi:'3.1.0',info:{title:'FactuEz B2B · lectura candidata',version:'1.0.0',description:'Contrato del listener aislado probado con datos ficticios. No desplegado en Kong. Sin emisión ni producción.'},'x-audience':B2bAudience,'x-runtime-enabled':false,paths,components:{securitySchemes:{B2bBearer:{type:'http',scheme:'bearer',bearerFormat:'JWT u OIDC introspectado según actor'},PrivateTransport:{type:'mutualTLS'}},schemas}};
}
/** Separate candidate: reads, drafts and explicitly gated owner-local issuance. */
export function b2bDraftOpenApiV1():S{
  const api=b2bReadOpenApiV1(),s=api.components.schemas,design=(b2bDesignOpenApiV1() as any).components.schemas;
  for(const name of ['DraftCreate','DraftPatch','EmptyCommand'])s[name]=structuredClone(design[name]);
  const customer=s.DraftCreate.properties.customer,lines=s.DraftCreate.properties.lines;
  customer.properties.legalName.maxLength=200;customer.properties.identityNumber.pattern='^[0-9]{1,15}$';
  lines.items.properties.description.maxLength=250;lines.items.properties.unitCode.pattern='^[A-Z0-9]{2,3}$';
  lines.items.properties.productCode.maxLength=40;
  s.DraftPatch.properties.customer=structuredClone(customer);s.DraftPatch.properties.lines=structuredClone(lines);
  s.Draft=obj({schemaVersion:version,id:uuid,context:ref('Context'),revision:{type:'string',pattern:'^"v[1-9][0-9]{0,8}"$'},documentType:val(['01','03']),currency:val(['PEN','USD']),paymentTerms:{type:'string',const:'CONTADO'},externalReference:s.DraftCreate.properties.externalReference,customer,lines,issueDate:{type:'string',format:'date'},state:val(['DRAFT','CANCELLED','ISSUED']),validatedRevision:nullable({type:'integer',minimum:1}),createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'}});
  const money={type:'string',pattern:'^[0-9]+\\.[0-9]{2}$'};
  s.Validation=obj({draftId:uuid,revision:s.Draft.properties.revision,profile:{const:'BETA_01_03_TAXABLE18_V1',type:'string'},valid:{const:true,type:'boolean'},issues:{type:'array',maxItems:0},totals:obj({taxableAmount:money,igvAmount:money,payableAmount:money}),fiscalActivation:{const:false,type:'boolean'}});
  s.Operation=obj({schemaVersion:version,operationId:uuid,commandId:uuid,requestId:uuid,environment:beta,context:ref('Context'),state:val(['SUCCEEDED','COMMITTED']),resourceId:uuid,action:val(['CREATE','PATCH','VALIDATE','CANCEL','ISSUE']),fiscalAcceptance:{const:'NOT_ASSERTED',type:'string'}});
  s.IssueCommit=obj({schemaVersion:version,context:ref('Context'),draftId:uuid,revision:s.Draft.properties.revision,documentId:uuid,
    series:text(4),number:{type:'string',pattern:'^[1-9][0-9]{0,7}$'},fullNumber:text(32),operationId:uuid,state:{const:'COMMITTED',type:'string'},fiscalAcceptance:{const:'NOT_ASSERTED',type:'string'}});
  const add=(method:string,path:string,id:string,response:string,body?:string)=>{
    const mutation=method!=='get',params:S[]=[{name:'X-FactuEz-Actor-Kind',in:'header',required:false,schema:val(['SERVICE','USER'])}];
    if(path.includes('{id}'))params.push({name:'id',in:'path',required:true,schema:uuid});
    if(!path.endsWith('/document-drafts'))params.push({name:'issuerId',in:'query',required:true,schema:issuerId},{name:'environment',in:'query',required:true,schema:beta});
    if(mutation||path.endsWith('/operations/lookup'))params.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{16,100}$'},description:'Clave estable del comando. No enviarla en URL; se almacena sólo su hash.'});
    if(mutation&&path.includes('{id}'))params.push({name:'If-Match',in:'header',required:true,schema:s.Draft.properties.revision});
    const responses:S={'200':{description:'Comando de borrador confirmado o replay; no emisión fiscal.',headers:mutation?{ETag:{schema:s.Draft.properties.revision},'X-Operation-Id':{schema:uuid},'X-Command-Id':{schema:uuid},'X-Idempotent-Replay':{schema:val(['true','false'])}}:{},content:{'application/json':{schema:ref(response)}}}};
    if(method==='post'&&path.endsWith('/document-drafts'))responses['201']=structuredClone(responses['200']);
    if(path.endsWith('/issue')){responses['202']=responses['200'];delete responses['200'];responses['202'].description='Commit local atómico, no aceptación SUNAT. Reintentar con la MISMA clave y cuerpo tras respuesta perdida; recuperar operationId por /operations/lookup.';}
    for(const code of [400,401,403,404,409,412,413,428,429,503])responses[String(code)]={description:'Error seguro; un fallo no consume correlativos.',content:{'application/json':{schema:ref('Error')}}};
    api.paths[path]={[method]:{operationId:id,'x-source-implemented':true,'x-runtime-enabled':false,security:[{B2bBearer:[],PrivateTransport:[]}],'x-required-scopes':path.endsWith('/issue')?['b2b:drafts:write','b2b:documents:issue']:[path.includes('/operations')?'b2b:operations:read':'b2b:drafts:write'],parameters:params,...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),responses}};
  };
  const base='/b2b/v1';
  add('post',base+'/document-drafts','b2bCreateDraft','Draft','DraftCreate');add('get',base+'/document-drafts/{id}','b2bReadDraft','Draft');
  // Same resource has GET and PATCH; preserve both declarations.
  const get=api.paths[base+'/document-drafts/{id}'].get;
  add('patch',base+'/document-drafts/{id}','b2bPatchDraft','Draft','DraftPatch');api.paths[base+'/document-drafts/{id}'].get=get;
  add('post',base+'/document-drafts/{id}/validate','b2bValidateDraft','Validation','EmptyCommand');add('post',base+'/document-drafts/{id}/cancel','b2bCancelDraft','Draft','EmptyCommand');
  add('post',base+'/document-drafts/{id}/issue','b2bIssueValidatedDraft','IssueCommit','EmptyCommand');
  add('get',base+'/operations/lookup','b2bRecoverDraftOperation','Operation');add('get',base+'/operations/{id}','b2bGetDraftOperation','Operation');
  api.info.title='FactuEz B2B · lectura, borradores y emisión candidata';api.info.description='23 rutas candidatas. Emisión local 01/03 con perfil BETA explícito, revisión validada y scope independiente; no activa transmisión oficial ni Kong.';
  return api;
}
/** Full candidate surface. No official transmission or webhook delivery activation. */
export function b2bCandidateOpenApiV1():S{
  const api=b2bDraftOpenApiV1(),schemas=api.components.schemas,legacy=(integrationOpenApiV1() as any).components.schemas;
  const imported=new Set<string>();
  const importSchema=(name:string)=>{if(imported.has(name))return;imported.add(name);
    const copy=structuredClone(legacy[name]);if(!copy)throw new Error('Unknown legacy schema: '+name);
    const visit=(v:any)=>{if(!v||typeof v!=='object')return;if(typeof v.$ref==='string'&&v.$ref.startsWith('#/components/schemas/')&&!v.$ref.startsWith('#/components/schemas/Legacy')){const dep=v.$ref.slice('#/components/schemas/'.length);v.$ref='#/components/schemas/Legacy'+dep;importSchema(dep);}for(const child of Object.values(v))visit(child);};visit(copy);schemas['Legacy'+name]=copy;
  };
  for(const name of ['DocumentPage','DocumentDetail','ExportJob','ExportRequest','ExportManifest','ChangePage'])importSchema(name);
  const body=structuredClone(schemas.LegacyExportRequest),filters=structuredClone(schemas.LegacyExportFilters);
  delete filters.properties.issuerRuc;filters.required=filters.required.filter((k:string)=>k!=='issuerRuc');filters.properties.types.items.enum=['01','03'];filters.properties.types.default=['01','03'];
  body.properties.filters=filters;schemas.B2bExportRequest=body;
  for(const name of ['DocumentPage','DocumentDetail','ExportJob','ExportManifest','ChangePage'])schemas['Wrapped'+name]=obj({schemaVersion:version,payloadContract:{const:'factuez.integration.v1',type:'string'},payload:ref('Legacy'+name)});
  const add=(method:string,path:string,id:string,response:string,options:{cut?:boolean;detail?:boolean;changes?:boolean;binary?:boolean;create?:boolean}={})=>{
    const parameters:S[]=[{name:'X-FactuEz-Actor-Kind',in:'header',required:false,schema:val(['SERVICE','USER'])},{name:'issuerId',in:'query',required:true,schema:issuerId},{name:'environment',in:'query',required:true,schema:beta}];
    for(const m of path.matchAll(/\{([^}]+)\}/g))parameters.push({name:m[1],in:'path',required:true,schema:uuid});
    if(options.cut){for(const name of ['from','to'])parameters.push({name,in:'query',required:true,schema:{type:'string',format:'date'}});for(const name of ['types','branchId','pointId','series','currency','fiscalStatus','limit','cursor'])parameters.push({name,in:'query',required:false,schema:name==='limit'?{type:'integer',minimum:1,maximum:100}:text(4096)});}
    if(options.changes)parameters.push({name:'checkpoint',in:'query',required:true,schema:text(4096)},{name:'limit',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:100}});
    if(options.create)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{16,128}$'}});
    const success=options.binary?{description:'ZIP con manifiesto y originales; no URLs públicas.',headers:{'Content-Length':{schema:{type:'integer',maximum:67108864}},'X-Content-SHA256':{schema:{type:'string',pattern:'^[a-f0-9]{64}$'}}},content:{'application/zip':{schema:{type:'string',format:'binary'}}}}:{description:'Payload versionado del motor existente con autorización B2B nueva.',content:{'application/json':{schema:ref(response)}}};
    const responses:S={[options.create?'202':'200']:success};for(const code of [400,401,403,404,409,410,413,422,429,503])responses[String(code)]={description:'Error seguro; no afecta emisión ni correlativos.',content:{'application/json':{schema:ref('Error')}}};
    api.paths[path]={[method]:{operationId:id,'x-source-implemented':true,'x-runtime-enabled':false,security:[{B2bBearer:[],PrivateTransport:[]}],'x-required-scopes':options.changes?['b2b:documents:read','b2b:changes:read']:options.create?['b2b:documents:read','b2b:exports:create']:options.cut||options.detail?['b2b:documents:read']:['b2b:documents:read','b2b:exports:read'],parameters,...(options.create?{requestBody:{required:true,content:{'application/json':{schema:ref('B2bExportRequest')}}}}:{}),responses}};
  };
  const base='/b2b/v1';add('get',base+'/document-cuts','b2bPersistentCut','WrappedDocumentPage',{cut:true});
  add('get',base+'/document-cuts/{snapshotId}/documents/{id}','b2bPersistentCutDetail','WrappedDocumentDetail',{detail:true});
  add('get',base+'/changes','b2bPersistentChanges','WrappedChangePage',{changes:true});
  add('post',base+'/exports','b2bCreateExport','WrappedExportJob',{create:true});add('get',base+'/exports/{id}','b2bExportStatus','WrappedExportJob');
  add('get',base+'/exports/{id}/manifest','b2bExportManifest','WrappedExportManifest');add('get',base+'/exports/{id}/content','b2bExportContent','',{binary:true});
  api.info.title='FactuEz B2B · API candidata implementada';
  return addB2bPhase8ExtraOpenApi(addB2bPhase8OpenApi(addB2bReceivedOpenApi(addB2bPhase7OpenApi(addB2bGuideArtifactOpenApi(addB2bGuideIssueOpenApi(addB2bGuideDraftRoutes(addB2bCorrectionRoutes(addB2bCommercialRoutes(addB2bWebhookRoutes(api))))))))));
}
