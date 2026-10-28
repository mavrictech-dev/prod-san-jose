import {productionScopes} from '@factuez/service-access/dist/b2b-production-contract';
import {productionOperations} from './production-facade';
const binding={type:'object',additionalProperties:false,required:['ruc','branchId','pointId','series'],properties:{ruc:{type:'string',pattern:'^[0-9]{11}$'},branchId:{type:'string',format:'uuid'},pointId:{type:'string',format:'uuid'},series:{type:'string',pattern:'^[A-Z0-9]{4}$'}}};
const secured=(scope:string)=>[{productionOAuth:[scope]}];
const json=(schema:unknown)=>({'application/json':{schema}});
const response=(description:string,schema:unknown={type:'object'})=>({description,content:json(schema)});
const body=(schema:unknown)=>({required:true,content:json(schema)});
const shape=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,required,properties});
const errors={'400':response('Invalid request'),'401':response('Invalid or revoked machine token'),'403':response('Scope or native binding denied'),'409':response('Revision/idempotency conflict, pending or uncertain command'),'503':response('Native owner or fiscal admission unavailable; no readiness inferred')};
const hookId={in:'path',name:'id',required:true,schema:{type:'string',format:'uuid'}};
/** OpenAPI JSON only; no UI/assets and no implicit privilege activation. */
export function productionOpenApi(){
 const paths:Record<string,unknown>={};
 paths['/b2b/production/oauth/token']={post:{
  operationId:'productionClientCredentials',summary:'Obtain a PRODUCTION SERVICE token (300 seconds)',security:[{clientBasic:[]}],
  requestBody:{required:true,content:{'application/x-www-form-urlencoded':{schema:shape({grant_type:{type:'string',enum:['client_credentials']},scope:{type:'string',description:'Space-separated explicit production scopes; no wildcard'}})}}},
  responses:{'200':response('Opaque bearer token',shape({access_token:{type:'string'},token_type:{type:'string',enum:['Bearer']},expires_in:{type:'integer',maximum:300},scope:{type:'string'}})),...errors}
 }};
 paths['/b2b/production/v1/capabilities']={get:{operationId:'productionCapabilities',security:[{productionOAuth:[]}],responses:{'200':response('Registration state only. Fiscal/native readiness is checked per command.'),...errors}}};
 paths['/b2b/production/v1/webhooks']={
  get:{operationId:'productionListWebhooks',security:secured('production:webhooks:manage'),responses:{'200':response('Owned subscriptions, without secret or ciphertext',{type:'array',items:{type:'object'}}),...errors}},
  post:{operationId:'productionCreateWebhook',security:secured('production:webhooks:manage'),requestBody:body(shape({
   binding:{$ref:'#/components/schemas/ProductionBinding'},destinationId:{type:'string',description:'Installer-approved HTTPS destination ID, never a raw URL'},
   events:{type:'array',uniqueItems:true,minItems:1,items:{type:'string',enum:['document.issued','document.status.changed','note.issued','guide.issued','guide.status.changed']}}
  })),responses:{'201':response('Subscription and plaintext secret returned exactly once. ACTIVE means enabled delivery, not fiscal readiness.'),...errors}}
 };
 for(const [operation,scope] of Object.entries(productionOperations)){
  const read=operation==='read'||operation.endsWith('Read');
  const description=operation.startsWith('note')?'Exact envelope {originalId,input:{seriesCounterId,adjustment,profile?}}. adjustment.documentTypeCode must match 07/08; native owner computes monetary values.':operation.startsWith('guide')?'Native {seriesCounterId,profile,body}; GRE09_PRIVATE04_V1 / GRE09_PUBLIC01_V1 / GRE31_PUBLIC_SINGLE09_V1.':operation==='read'?'Exact query {documentId?,after?,limit?}, 1..100, restricted to granted native series.':'Native producer input; its source validation is authoritative. No values are silently rewritten.';
  paths['/b2b/production/v1/operations/'+operation]={post:{
   operationId:'production_'+operation,summary:'Native '+operation+' as SERVICE',
   description:/^(masters|users)/.test(operation)?'Separate privilege and explicit enablement required; default disabled.':'Native producer and fiscal policy validation is mandatory. No human JWT impersonation.',
   security:secured(scope),parameters:read?[]:[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'}}],
   requestBody:body(shape({binding:{$ref:'#/components/schemas/ProductionBinding'},payload:{type:'object',description}})),
   responses:{[read?'200':'202']:response('Native result; acceptance here does not imply SUNAT acceptance'),...errors}
  }};
 }
 for(const action of ['pause','resume','rotate'])paths['/b2b/production/v1/webhooks/{id}/'+action]={post:{
  operationId:'productionWebhook_'+action,security:secured('production:webhooks:manage'),parameters:[hookId],
  requestBody:body(shape({revision:{type:'integer',minimum:1}})),
  responses:{'200':response(action==='rotate'?'New plaintext secret returned exactly once; in-flight deliveries may finish using previous key ID.':'Updated subscription'),...errors}
 }};
 paths['/b2b/production/v1/webhooks/{id}/deliveries']={get:{operationId:'productionWebhookDeliveries',security:secured('production:webhooks:manage'),parameters:[hookId],responses:{'200':response('Durable delivery states',{type:'array',items:{$ref:'#/components/schemas/ProductionDelivery'}}),...errors}}};
 return {openapi:'3.0.3',info:{title:'FactuEz B2B PRODUCTION SERVICE',version:'1.0.0',description:'Dedicated explicit profile. Independent of BETA owner graph; never grants BETA/fullgraph readiness. Private listener requires an approved mTLS peer. Native producer and fiscal policy gates remain authoritative.'},paths,components:{
  securitySchemes:{clientBasic:{type:'http',scheme:'basic'},productionOAuth:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'/b2b/production/oauth/token',scopes:Object.fromEntries(productionScopes.map(s=>[s,s]))}}}},
  schemas:{ProductionBinding:binding,ProductionDelivery:{type:'object',properties:{id:{type:'string'},state:{type:'string',enum:['QUEUED','IN_FLIGHT','RETRY_SCHEDULED','ACKNOWLEDGED','DEAD']},attempts:{type:'integer'},lastOutcome:{type:'string'},lastStatus:{type:'integer'},nextAt:{type:'integer',description:'Unix milliseconds'},acknowledgedAt:{type:'integer'}}}}
 }};
}
