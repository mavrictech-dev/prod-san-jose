type S=Record<string,any>;
/** Actual candidate routes. The wider event catalog remains a separate design artifact. */
export function addB2bWebhookRoutes(api:S){
  const s=api.components.schemas,ref=(n:string)=>({$ref:'#/components/schemas/'+n}),text=(maxLength=120)=>({type:'string',maxLength}),uuid={type:'string',format:'uuid'},version={type:'string',const:'factuez.b2b.v1'};
  const obj=(properties:S,optional:string[]=[])=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties).filter(k=>!optional.includes(k))}),nullable=(v:S)=>({anyOf:[v,{type:'null'}]});
  const revision={type:'string',pattern:'^"v[1-9][0-9]{0,8}"$'},events={type:'array',const:['document.issued-locally.v1']};
  const sub={id:uuid,context:ref('Context'),label:text(),destinationId:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,39}$'},revision,enabled:{type:'boolean'},verified:{type:'boolean'},events,createdAt:{type:'string',format:'date-time'}};
  s.HookSubscription=obj(sub);s.HookSubscriptionResult=obj({schemaVersion:version,...sub,secretAlreadyShown:{type:'boolean'},signingSecret:{type:'string',pattern:'^whsec_[A-Za-z0-9+/]{43}=$',description:'Sólo en la primera respuesta de alta/rotación; nunca en GET ni replay.'}},['secretAlreadyShown','signingSecret']);
  s.HookCreate=obj({binding:ref('Context'),label:text(),destinationId:sub.destinationId,events});s.HookPatch=obj({label:text(),destinationId:sub.destinationId,enabled:{type:'boolean'}},['label','destinationId','enabled']);s.HookPatch.minProperties=1;
  const d={id:uuid,subscriptionId:uuid,eventId:uuid,state:{type:'string',enum:['PENDING','RUNNING','RETRY','DELIVERED','DEAD_LETTER','CANCELLED']},attempts:{type:'integer',minimum:0,maximum:8},round:{type:'integer',minimum:0,maximum:5},nextAttemptAt:nullable({type:'string',format:'date-time'}),lastCode:nullable(text()),statusCode:nullable({type:'integer'})};
  s.HookDelivery=obj({...d,context:ref('Context')});s.HookDeliveryResult=obj({schemaVersion:version,...d,context:ref('Context'),history:{type:'array',maxItems:100,items:obj({id:uuid,deliveryId:uuid,number:{type:'integer'},round:{type:'integer'},at:{type:'integer',description:'Epoch milliseconds'},code:text(),status:nullable({type:'integer'})})}},['history']);
  for(const [name,item]of [['HookSubscriptionList','HookSubscription'],['HookDeliveryList','HookDelivery']])s[name]=obj({schemaVersion:version,items:{type:'array',maxItems:100,items:ref(item)},page:obj({hasMore:{type:'boolean'},nextCursor:nullable(uuid)})});
  const add=(method:string,path:string,id:string,response:string,body?:string)=>{
    const mutate=method!=='get',parameters:S[]=[{name:'issuerId',in:'query',required:true,schema:{type:'integer',minimum:1}},{name:'environment',in:'query',required:true,schema:{type:'string',const:'BETA'}},{name:'X-FactuEz-Actor-Kind',in:'header',required:false,schema:{enum:['SERVICE','USER'],type:'string'}}];
    if(path.includes('{id}'))parameters.push({name:'id',in:'path',required:true,schema:uuid});else if(!mutate)parameters.push({name:'after',in:'query',required:false,schema:uuid});
    if(mutate)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{16,100}$'}});
    if(mutate&&path.includes('{id}'))parameters.push({name:'If-Match',in:'header',required:true,schema:revision,description:'Revisión de la SUSCRIPCIÓN, también para replay.'});
    const responses:S={[id==='b2bCreateWebhook'?'201':id==='b2bReplayWebhook'?'202':'200']:{description:'Resultado autorizado; entrega no equivale a aceptación SUNAT.',content:{'application/json':{schema:ref(response)}}}};
    for(const code of [400,401,403,404,409,412,413,422,428,429,503])responses[code]={description:'Error seguro',content:{'application/json':{schema:ref('Error')}}};
    api.paths['/b2b/v1'+path]??={};api.paths['/b2b/v1'+path][method]={operationId:id,'x-source-implemented':true,'x-runtime-enabled':false,'x-required-scopes':['b2b:documents:read',mutate?'b2b:webhooks:manage':'b2b:webhooks:read'],security:[{B2bBearer:[],PrivateTransport:[]}],parameters,...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),responses};
  };
  add('get','/webhook-subscriptions','b2bListWebhooks','HookSubscriptionList');add('post','/webhook-subscriptions','b2bCreateWebhook','HookSubscriptionResult','HookCreate');
  add('get','/webhook-subscriptions/{id}','b2bGetWebhook','HookSubscriptionResult');add('patch','/webhook-subscriptions/{id}','b2bPatchWebhook','HookSubscriptionResult','HookPatch');
  add('post','/webhook-subscriptions/{id}/verify','b2bVerifyWebhook','HookSubscriptionResult','EmptyCommand');add('post','/webhook-subscriptions/{id}/rotate-secret','b2bRotateWebhook','HookSubscriptionResult','EmptyCommand');
  add('get','/webhook-deliveries','b2bListWebhookDeliveries','HookDeliveryList');add('get','/webhook-deliveries/{id}','b2bGetWebhookDelivery','HookDeliveryResult');add('post','/webhook-deliveries/{id}/replay','b2bReplayWebhook','HookDeliveryResult','EmptyCommand');
  api.info.description='39 operaciones candidatas: lectura/extracción, borradores/emisión local 01/03 y webhooks privados de emisión local. No desplegado en Kong. Sin envíos oficiales ni aceptación fiscal verificada.';
  return api;
}
