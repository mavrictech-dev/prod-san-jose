/** Exact candidate incoming read surface, not activation of connectors or APIs. */
export function addB2bReceivedOpenApi(api:any){
  const s=api.components.schemas,ref=(name:string)=>({$ref:'#/components/schemas/'+name});
  const obj=(properties:any)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const text=(maxLength=8192)=>({type:'string',maxLength}),nullable=(maxLength=8192)=>({type:['string','null'],maxLength});
  const uuid={type:'string',format:'uuid'},sha={type:'string',pattern:'^[a-f0-9]{64}$'},constant=(value:any)=>({type:typeof value,const:value});
  const arr=(items:any,maxItems=1000)=>({type:'array',maxItems,items}),date={type:'string',format:'date'};
  const decimal={type:['string','null'],pattern:'^[+-]?[0-9]{1,30}(?:\\.[0-9]{1,20})?$'},currency={type:['string','null'],pattern:'^[A-Z]{3}$'};
  s.ReceivedScope=obj({environment:constant('BETA'),companyId:{type:'integer',minimum:1,maximum:2147483647},recipientRuc:{type:'string',pattern:'^[0-9]{11}$'},branchId:uuid});
  s.ReceivedParty=obj({identityNumber:nullable(),identityType:nullable(),legalName:nullable(),address:nullable(81958)});
  s.ReceivedTax=obj({schemeId:nullable(),name:nullable(),amount:decimal,taxableAmount:decimal,percent:decimal,affectationCode:nullable()});
  s.ReceivedItem=obj({lineId:{...text(4096),minLength:1},description:text(81939),supplierCode:nullable(),sunatCode:nullable(),unitCode:nullable(),
    quantity:decimal,unitValue:decimal,unitPrice:decimal,lineExtensionAmount:decimal,
    allowances:arr(obj({charge:{type:'boolean'},amount:decimal,reason:nullable()}),100),taxes:arr(ref('ReceivedTax'))});
  s.ReceivedProjection=obj({schemaVersion:constant('factuez.received-document.v1'),documentType:text(2),fullNumber:text(41),series:text(20),number:text(20),issueDate:date,
    issueTime:nullable(),dueDate:{type:['string','null'],format:'date'},currencyCode:currency,supplier:ref('ReceivedParty'),recipient:ref('ReceivedParty'),items:arr(ref('ReceivedItem')),
    totals:obj(Object.fromEntries(['lineExtensionAmount','taxExclusiveAmount','taxInclusiveAmount','allowanceTotalAmount','chargeTotalAmount','prepaidAmount','payableAmount'].map(k=>[k,decimal]))),
    taxes:arr(ref('ReceivedTax')),paymentTerms:arr(obj({id:nullable(),means:nullable(),amount:decimal,dueDate:{type:['string','null'],format:'date'}}),100),references:arr(obj({kind:{...text(),minLength:1},number:nullable(),documentType:nullable()})),
    notes:arr(text(),100),warnings:arr(text(),200),xmlSha256:sha,signature:obj({status:{type:'string',enum:['MISSING','PRESENT_UNVERIFIED']},officialTrust:constant(false)})});
  s.ReceivedArtifact=obj({id:uuid,kind:{type:'string',enum:['XML','CDR','PROVIDER_PDF']},fileName:text(150),mediaType:{type:'string',enum:['application/xml','application/zip','application/pdf']},
    sha256:sha,byteLength:{type:'integer',minimum:1,maximum:10*1024*1024},representation:constant('PROVIDER_ORIGINAL'),signatureTrust:constant('NOT_VERIFIED')});
  s.ReceivedRow=obj({id:uuid,companyId:{type:'integer'},recipientRuc:text(11),branchId:uuid,supplierRuc:text(11),supplierName:nullable(),documentType:text(2),fullNumber:text(41),
    issueDate:date,currencyCode:currency,payableAmount:decimal,receivedAt:{type:'string',format:'date-time'},itemCount:{type:'integer',minimum:0,maximum:1000},
    sunatStatus:constant('NOT_CHECKED'),lastVerifiedAt:{type:'null'},registeredAt:{type:['string','null'],format:'date-time'},erpReference:nullable(),warnings:arr(text(),200)});
  s.ReceivedDetail=obj({schemaVersion:constant('factuez.b2b.received-detail.v1'),scope:ref('ReceivedScope'),document:ref('ReceivedRow'),projection:ref('ReceivedProjection'),
    artifacts:arr(ref('ReceivedArtifact'),20),fiscalAcceptance:constant('NOT_VERIFIED'),source:constant('RECEIVED_XML')});
  s.ReceivedPage=obj({schemaVersion:constant('factuez.b2b.received-page.v1'),scope:ref('ReceivedScope'),items:arr(ref('ReceivedRow'),100),page:obj({limit:{type:'integer',minimum:1,maximum:100},
    hasMore:{type:'boolean'},nextAfter:{type:['string','null'],format:'uuid'},consistency:constant('LIVE_KEYSET_NOT_SNAPSHOT')}),fiscalAcceptance:constant('NOT_VERIFIED'),source:constant('RECEIVED_XML')});
  s.ReceivedManifest=obj({schemaVersion:constant('factuez.b2b.received-artifacts.v1'),scope:ref('ReceivedScope'),documentId:uuid,items:arr(ref('ReceivedArtifact'),20),fiscalAcceptance:constant('NOT_VERIFIED')});
  s.Capabilities.properties.receivedCoverage=obj({source:constant('RECEIVED_XML_ONLY'),unassigned:constant(false),sireOnlyFindings:constant(false),officialTrust:constant(false)});
  api.tags.push({name:'receiveddocuments',description:'Compras recibidas, dominio separado de las ventas emitidas. Ítems desde XML original; no inventa detalle desde SIRE.'});
  for(const action of ['list','detail','artifacts','content']){
    const list=action==='list',binary=action==='content',files=action==='artifacts'||binary;
    const path='/b2b/v1/received-documents'+(list?'':'/{id}')+(files?'/artifacts':'')+(binary?'/{artifactId}/content':'');
    const params:any[]=[{name:'X-FactuEz-Actor-Kind',in:'header',required:true,schema:{type:'string',enum:['SERVICE','USER']}}];
    for(const [name,schema]of Object.entries(s.ReceivedScope.properties))params.push({name,in:'query',required:true,schema});
    if(!list)params.push({name:'id',in:'path',required:true,schema:uuid});
    if(binary)params.push({name:'artifactId',in:'path',required:true,schema:uuid});
    if(list)params.push({name:'from',in:'query',required:true,schema:date},{name:'to',in:'query',required:true,schema:date},
      {name:'type',in:'query',schema:{type:'string',enum:['01','03','07','08','09','20','31','40']}},{name:'after',in:'query',schema:uuid},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:25}});
    const responses:any={'200':{description:binary?'Original exacto; integridad SHA256 comprobada, confianza y aceptación fiscal NO acreditadas.':'Lectura local autorizada; el detalle se contrasta con XML original.',
      content:binary?Object.fromEntries(['application/xml','application/zip','application/pdf'].map(m=>[m,{schema:{type:'string',format:'binary'}}])):{'application/json':{schema:ref(list?'ReceivedPage':action==='detail'?'ReceivedDetail':'ReceivedManifest')}}}};
    for(const status of [400,401,403,404,409,413,429,503])responses[status]={description:'Error finito sin datos privados; 404 para otro RUC/sede o original ausente, 409 ante integridad inconsistente.',content:{'application/json':{schema:ref('Error')}}};
    api.paths[path]={get:{operationId:'b2bReceived_'+action,tags:['receiveddocuments'],summary:'Documentos recibidos: '+action,
      description:'mTLS y Bearer SERVICE/USER; permiso y concesión independiente de recepción por destinatario/RUC/sede. No hereda privilegios de emisión. Sólo documentos asignados a una sede concedida; sin acceso a compras sin asignar. '
        +(list?'Rango máximo366 días, límite100, keyset vivo porID: no corte histórico ni total global.':'Los ítems/impuestos provienen del XML, no de totales SIRE. Descarga CDR sólo si relacionado con el XML; firma/PKI SUNAT no afirmadas.'),
      parameters:params,security:[{B2bBearer:[],PrivateTransport:[]}],'x-source-implemented':true,'x-runtime-enabled':false,'x-candidate-only':true,
      'x-required-scopes':files?['b2b:received:read','b2b:received:artifacts:read']:['b2b:received:read'],responses}};
  }return api;
}
