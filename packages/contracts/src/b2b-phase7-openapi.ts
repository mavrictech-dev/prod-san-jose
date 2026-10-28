import { b2bGuideIssueScopes, b2bGuideIssueReadScopes } from './b2b-guide-security';

/** Actual opt-in LOCAL/BETA routes. Runtime activation and fiscal approval are
 * separate evidence; neither is inferred from this source contract. */
export function addB2bPhase7OpenApi(api:any) {
  const s=api.components.schemas,ref=(name:string)=>({$ref:'#/components/schemas/'+name});
  const obj=(properties:any)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const text=(maxLength:number)=>({type:'string',minLength:1,maxLength}),constant=(value:any)=>({type:typeof value,const:value});
  const uuid={type:'string',format:'uuid'},sha={type:'string',pattern:'^[a-f0-9]{64}$'},date={type:'string',format:'date'};
  const revision={type:'string',pattern:'^"v[1-9][0-9]{0,8}"$'},party=obj({ruc:{type:'string',pattern:'^[0-9]{11}$'},legalName:text(250)});
  const location=obj({ubigeo:{type:'string',pattern:'^[0-9]{6}$'},address:text(500)});
  s.CarrierGuideBinding=structuredClone(s.GuideIssueBinding);
  s.CarrierGuideBinding.properties.draft=structuredClone(s.GuideDraftBinding);
  s.CarrierGuideBinding.properties.draft.properties.guideType=constant('31');
  s.CarrierGuideBinding.description='Permiso explícito 31 de tres series. No se deriva de WRITE de borrador ni de una serie 09.';
  s.CarrierGuideBody=obj({issueDate:{type:'string',format:'date-time'},transferDate:date,sender:party,recipient:party,origin:location,destination:location,
    grossWeight:{type:'string',pattern:'^(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,3})?$'},weightUnit:{type:'string',enum:['KGM','TNE']},
    transport:obj({mode:constant('01'),carrier:obj({...party.properties,mtcRegistration:{type:'string',pattern:'^[A-Z0-9-]{1,20}$'}}),
      vehicle:obj({plate:{type:'string',pattern:'^[A-Z0-9]{6,8}$'},tuc:{type:'string',pattern:'^[A-Z0-9]{1,15}$'}}),
      driver:obj({identityType:{type:'string',enum:['1','4']},identityNumber:{type:'string',pattern:'^[A-Z0-9]{1,12}$'},firstName:text(125),lastName:text(125),license:{type:'string',pattern:'^[A-Z0-9]{1,10}$'}})}),
    reference09:obj({documentId:uuid,issuerRuc:party.properties.ruc,series:{type:'string',pattern:'^T[A-Z0-9]{3}$'},number:{type:'string',pattern:'^[1-9][0-9]{0,7}$'},snapshotSha256:sha}),
    items:{type:'array',minItems:1,maxItems:100,items:obj({code:text(30),description:text(500),quantity:{type:'string',pattern:'^(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,10})?$'},unitCode:{type:'string',pattern:'^[A-Z0-9]{2,3}$'}})},
    totalTransfer:constant(true),freightPayer:constant('SENDER'),subcontracted:constant(false),regulatedGoods:constant(false)});
  s.CarrierGuideReadyRequest=obj({binding:ref('CarrierGuideBinding'),body:ref('CarrierGuideBody')});
  s.CarrierGuideReady=obj({draftId:uuid,revision,bodySha256:sha});
  s.CarrierGuideIssuedSnapshot=structuredClone(s.GuideIssuedSnapshot);
  Object.assign(s.CarrierGuideIssuedSnapshot.properties,{schemaVersion:constant('factuez.carrier-issued-local.v1'),binding:ref('CarrierGuideBinding'),
    series:{type:'string',pattern:'^V[A-Z0-9]{3}$'},fullNumber:{type:'string',pattern:'^V[A-Z0-9]{3}-[1-9][0-9]{0,7}$'},body:ref('CarrierGuideBody')});
  s.CarrierGuideIssuance=obj({schemaVersion:constant('factuez.b2b.carrier-guide-issuance.v1'),operationId:uuid,draftId:uuid,binding:ref('CarrierGuideBinding'),
    snapshot:ref('CarrierGuideIssuedSnapshot'),snapshotSha256:sha,replayed:{type:'boolean'}});
  s.BatchMemberReference=obj({documentId:uuid,version:{type:'integer',minimum:1},snapshotSha256:sha});
  s.BatchMemberScope=obj({environment:constant('BETA'),issuerRuc:party.properties.ruc,companyId:{type:'integer',minimum:1,maximum:2147483647},branchId:uuid});
  const batchBase={schemaVersion:constant('factuez.b2b.batch-members.v1'),scope:ref('BatchMemberScope'),
    idempotencyKey:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'},issueDate:date,referenceDate:date};
  s.BatchMemberRequest={oneOf:[obj({...batchBase,kind:constant('RC'),entries:{type:'array',minItems:1,maxItems:100,items:{oneOf:[
    obj({member:ref('BatchMemberReference'),conditionCode:constant('1')}),obj({member:ref('BatchMemberReference'),conditionCode:{type:'string',enum:['2','3']},previous:ref('BatchMemberReference')})]}}}),
    obj({...batchBase,kind:constant('RA'),entries:{type:'array',minItems:1,maxItems:100,items:obj({member:ref('BatchMemberReference'),reasonDescription:text(100)})}})]};
  s.BatchOperation=obj({schemaVersion:constant('factuez.b2b.batch-operation.v1'),operationId:uuid,identifier:{type:'string',pattern:'^(?:RC|RA)-[0-9]{8}-[1-9][0-9]{0,14}$'},
    kind:{type:'string',enum:['RC','RA']},scope:ref('BatchMemberScope'),state:{type:'string',enum:['PREPARED','COMPLETED','UNKNOWN']},memberCount:{type:'integer',minimum:1,maximum:100},
    commandSha256:sha,replayed:{type:'boolean'},candidateOnly:constant(true),localOnly:constant(true),fiscalExecutionEnabled:constant(false),transmissionAuthorized:constant(false),officialAcceptance:constant(false)});
  const actor={name:'X-FactuEz-Actor-Kind',in:'header',required:true,schema:{type:'string',enum:['SERVICE','USER']}};
  const add=(path:string,method:string,id:string,response:string,scopes:readonly string[],parameters:any[],body:any,description:string)=>{
    const responses:any={'200':{description:'Resultado candidato LOCAL/BETA; no acredita aceptación fiscal ni traslado.',content:{'application/json':{schema:ref(response)}}}};
    for(const code of [400,401,403,404,409,412,413,422,428,429,503])responses[code]={description:'Error finito sin claves ni respuesta interna.',content:{'application/json':{schema:ref('Error')}}};
    api.paths[path]??={};api.paths[path][method]={operationId:id,tags:[id.includes('Batch')?'batchoperations':'carrierguides'],summary:id,description,
      parameters:[actor,...parameters],security:[{B2bBearer:[],PrivateTransport:[]}],'x-source-implemented':true,'x-runtime-enabled':false,'x-candidate-only':true,
      'x-required-scopes':[...scopes],responses,...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{})};
  };
  api.tags.push({name:'carrierguides',description:'Contrato completo e independiente GT31, referencia09 pública autenticada. Sólo LOCAL/BETA.'},
    {name:'batchoperations',description:'RC alta/modificación/baja y RA con versiones y grants completos. Sin despacho fiscal.'});
  const base='/b2b/v1/carrier-guide-drafts/{id}',pathId={name:'id',in:'path',required:true,schema:uuid};
  add(base+'/ready','post','b2bCarrierGuideReady','CarrierGuideReady',b2bGuideIssueScopes,[pathId],ref('CarrierGuideReadyRequest'),
    'Guarda contrato completo 31 en el propietario; no consume correlativo. Requiere permiso de emisión independiente y catálogos versionados. No acepta XML/CDR/aceptación del cliente. Repetir datos idénticos conserva revisión.');
  add(base+'/issuance','post','b2bCarrierGuideIssue','CarrierGuideIssuance',b2bGuideIssueScopes,[pathId,
    {name:'If-Match',in:'header',required:true,schema:revision},{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{16,100}$'}}],
    obj({binding:ref('CarrierGuideBinding')}),'Reserva V y snapshot completo atómicamente con journal. Misma clave, revisión y tupla recuperan el recibo; no hay retransmisión ni producción.');
  const query=Object.entries({...s.Context.properties,guideSeriesId:uuid,guideType:constant('31'),fiscalSeriesId:uuid}).map(([name,schema])=>({name,in:'query',required:true,schema}));
  add(base+'/issuances/{operationId}','get','b2bCarrierGuideRead','CarrierGuideIssuance',b2bGuideIssueReadScopes,
    [pathId,{name:'operationId',in:'path',required:true,schema:uuid},...query],null,'Sólo lectura del original numerado, con diez parámetros y grants READ vigentes. GET no firma ni reserva. Los archivos se consultan en /guide-drafts/{id}/issuances/{operationId}/artifacts con tupla31.');
  for(const action of ['prepare','recover'])add('/b2b/v1/batches/'+action,'post',action==='prepare'?'b2bBatchPrepare':'b2bBatchRecover','BatchOperation',
    [action==='prepare'?'b2b:batches:write':'b2b:batches:read'],[],ref('BatchMemberRequest'),
    action==='prepare'?'Solicitud exacta de hasta100 versiones propias. El servidor fija asOf, resuelve notas/previas/historial, autoriza todos los miembros y reserva una sola identidad. Ante respuesta perdida usar recover con solicitud idéntica; no crear otra clave.'
      :'Recuperación explícita, sin reservar ni despachar. Misma solicitud y actor; cada miembro y dependencia necesitan READ vigente. Un journal ausente no se inventa; UNKNOWN no permite reenvío.');
  s.BatchArtifactScope=obj({...s.BatchMemberScope.properties,batchId:uuid});
  const batchFlags=Object.fromEntries(Object.entries({candidateOnly:true,localOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false,
    officialCdrVerified:false,certificateTrusted:false,signatureVerifiedLocally:true}).map(([k,v])=>[k,constant(v)]));
  s.BatchArtifactMetadata=obj({schemaVersion:constant('factuez.batch-artifacts-local.v1'),scope:ref('BatchArtifactScope'),operationId:uuid,eventId:uuid,
    kind:{type:'string',enum:['RC','RA']},identifier:{type:'string',pattern:'^(?:RC|RA)-[0-9]{8}-[1-9][0-9]{0,14}$'},
    commandSha256:sha,envelopeSha256:sha,batchSnapshotSha256:sha,unsignedXmlSha256:sha,xmlSha256:sha,zipSha256:sha,
    digestValue:{type:'string',pattern:'^[A-Za-z0-9+/]+={0,2}$'},certificateFingerprintSha256:sha,fileName:text(100),...batchFlags});
  s.BatchArtifactView=obj({schemaVersion:constant('factuez.b2b.batch-artifacts.v1'),scope:ref('BatchArtifactScope'),metadata:ref('BatchArtifactMetadata'),replayed:{type:['boolean','null']}});
  api.tags.push({name:'batchartifacts',description:'Originales inmutables RC/RA de ensayo, separados de la aceptación fiscal de los miembros.'});
  for(const action of ['prepare','read','content']){
    const prepare=action==='prepare',binary=action==='content',path='/b2b/v1/batches/{id}/local-artifacts'+(binary?'/{artifact}':'');
    const parameters:any[]=[actor,pathId];
    if(!prepare)for(const [name,schema]of Object.entries(s.BatchMemberScope.properties))parameters.push({name,in:'query',required:true,schema});
    if(binary)parameters.push({name:'artifact',in:'path',required:true,schema:{type:'string',enum:['xml','zip','cdr-xml','cdr-zip']}});
    const responses:any={'200':{description:binary?'Bytes originales de ensayo; CDR sólo si archivado y verificado por el dueño.':'Metadatos de originales locales. GET nunca prepara, firma ni reserva.',
      content:binary?Object.fromEntries(['application/xml','application/zip'].map(m=>[m,{schema:{type:'string',format:'binary'}}])):{'application/json':{schema:ref('BatchArtifactView')}}}};
    for(const status of [400,401,403,404,409,413,429,503])responses[status]={description:'Error finito. 404 si falta original o CDR, sin archivos fabricados.',content:{'application/json':{schema:ref('Error')}}};
    api.paths[path]??={};api.paths[path][prepare?'post':'get']={operationId:'b2bBatchArtifacts_'+action,tags:['batchartifacts'],summary:'Originales locales RC/RA: '+action,
      description:'Alcance BETA completo y batchId persistido; autorización actual de todos los miembros y dependencias. No acepta XML/CDR subidos, claves, paths ni aprobación del consumidor. CDR local no concede aceptación de miembros ni activa transporte. Cuatro parámetros planos en GET.',
      security:[{B2bBearer:[],PrivateTransport:[]}],parameters,'x-source-implemented':true,'x-runtime-enabled':false,'x-candidate-only':true,
      'x-required-scopes':prepare?['b2b:batches:write']:['b2b:batches:read','b2b:artifacts:read'],responses,
      ...(prepare?{requestBody:{required:true,content:{'application/json':{schema:obj({scope:ref('BatchArtifactScope')})}}}}:{})};
  }
  return api;
}
