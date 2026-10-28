type S=Record<string,any>;
/** Concrete candidate operations only. Does not enable routes, transmission or PKI trust. */
export function addB2bCorrectionRoutes(api:S){
  const s=api.components.schemas,ref=(name:string)=>({$ref:'#/components/schemas/'+name});
  const obj=(properties:S)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
  const uuid={type:'string',format:'uuid'},sha={type:'string',pattern:'^[a-f0-9]{64}$'},money={type:'string',pattern:'^[0-9]+\\.[0-9]{2}$'};
  const text=(maximum:number)=>({type:'string',minLength:1,maxLength:maximum});
  const noActivation={candidateOnly:{type:'boolean',const:true},fiscalExecutionEnabled:{type:'boolean',const:false},transmissionAuthorized:{type:'boolean',const:false}};
  const original=structuredClone(s.Context);original.properties.documentType={type:'string',const:'01'};
  s.CorrectionBinding=obj({reference:original,noteSeriesId:uuid,noteType:{type:'string',enum:['07','08']}});
  const line=(field:string,scale:number)=>({type:'array',minItems:1,maxItems:100,items:obj({originalLineNumber:{type:'integer',minimum:1,maximum:100},[field]:{type:'string',pattern:`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${scale}})?$`,description:'Delta/cantidad estrictamente positivo; validación exacta por el propietario.'}})});
  const note=(type:string,reasons:string[],extra:S={})=>obj({documentTypeCode:{type:'string',const:type},reasonCode:{type:'string',enum:reasons},reasonDescription:text(250),...extra});
  s.CorrectionAdjustment={oneOf:[note('07',['01','06']),note('07',['07'],{lines:line('quantity',6)}),note('07',['05','09'],{lines:line('unitPriceAdjustmentWithTax',6)}),note('08',['02'],{lines:line('unitPriceAdjustmentWithTax',6)}),note('08',['01'],{interestNature:{type:'string',const:'MORATORIO'},interestBasis:text(500),lines:line('interestAmount',2)})]};
  s.EnterpriseCorrectionCreate=obj({schemaVersion:{type:'string',const:'factuez.b2b.correction-create.v1'},binding:ref('CorrectionBinding'),originalDocumentId:uuid,
    idempotencyKey:{type:'string',minLength:16,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]*$',description:'Repetir exactamente cuerpo/clave tras respuesta perdida. Se conserva recibo atómico y hash, no la clave.'},
    externalReference:obj({namespace:{...text(64),pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]*$'},value:text(200)}),note:ref('CorrectionAdjustment'),issueDate:{type:'string',format:'date-time'}});
  s.CorrectionSnapshotParty={...obj({identityType:text(4),identityNumber:text(32),legalName:text(500),address:text(1000),ubigeo:{type:'string',pattern:'^[0-9]{6}$'},establishmentCode:{type:'string',pattern:'^[0-9]{4}$'}}),required:['identityType','identityNumber','legalName']};
  const decimal={type:'string',pattern:'^[0-9]+(?:\\.[0-9]{1,6})?$'};
  s.CorrectionSnapshotItem={...obj({lineNumber:{type:'integer',minimum:1,maximum:100},originalLineNumber:{type:'integer',minimum:1,maximum:100},productCode:text(40),description:text(250),unitCode:text(3),quantity:decimal,unitValue:decimal,unitPriceWithTax:decimal,taxAffectationCode:{type:'string',enum:['10','30']},igvRate:decimal,lineExtensionAmount:money,igvAmount:money,totalAmount:money}),required:['lineNumber','originalLineNumber','description','unitCode','quantity','unitValue','unitPriceWithTax','taxAffectationCode','igvRate','lineExtensionAmount','igvAmount','totalAmount']};
  s.EnterpriseCorrectionDocument=obj({id:uuid,typeCode:{type:'string',enum:['07','08']},series:{type:'string',pattern:'^F[A-Z0-9]{3}$'},number:{type:'string',pattern:'^[1-9][0-9]{0,7}$'},fullNumber:text(32),issueDate:{type:'string',format:'date-time'},currency:{type:'string',const:'PEN'},
    issuer:ref('CorrectionSnapshotParty'),customer:ref('CorrectionSnapshotParty'),reference:obj({documentId:uuid,documentTypeCode:{type:'string',const:'01'},fullNumber:text(32),issueDate:{type:'string',format:'date-time'},snapshotSha256:sha}),reason:obj({code:text(2),description:text(250)}),
    items:{type:'array',minItems:1,maxItems:100,items:ref('CorrectionSnapshotItem')},
    totals:obj({taxableAmount:money,unaffectedAmount:money,igvAmount:money,payableAmount:money})});
  s.EnterpriseCorrectionResult=obj({operationId:uuid,originalDocumentId:uuid,commandSha256:sha,actorSha256:sha,noteSha256:sha,state:{type:'string',enum:['RESERVED','ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED'],description:'Estado del journal candidato derivado de evidencia propietaria; no habilita emisión oficial.'},document:ref('EnterpriseCorrectionDocument'),revision:{type:'integer',minimum:1,maximum:200},headSha256:sha,creditHeld:money,debitHeld:money,netAmount:money,deduplicated:{type:'boolean'},...noActivation});
  s.EnterpriseCorrectionReceipt=obj({operationId:uuid,binding:ref('CorrectionBinding'),result:ref('EnterpriseCorrectionResult'),...noActivation});
  s.EnterpriseCorrectionSettle=obj({binding:ref('CorrectionBinding')});
  const add=(method:string,path:string,id:string,body?:string)=>{
    const params:S[]=[{name:'X-FactuEz-Actor-Kind',in:'header',required:false,schema:{type:'string',enum:['SERVICE','USER']}}];
    if(path.includes('{id}'))params.push({name:'id',in:'path',required:true,schema:uuid});
    if(method==='get')for(const [name,schema]of Object.entries({...original.properties,noteSeriesId:uuid,noteType:{type:'string',enum:['07','08']}}))params.push({name,in:'query',required:true,schema});
    const responses:S={[path.endsWith('/correction-notes')?'202':'200']:{description:method==='get'?'Detalle y estado del journal propio. Sin comandos privados ni secretos.':path.endsWith('/settle')?'Conciliar sólo evidencia propia ya disponible. No envía SOAP ni libera retenciones por rechazo.':'Reserva local atómica de nota/ítems/correlativo/Outbox/journal/recibo. No aceptación ni transmisión SUNAT.',content:{'application/json':{schema:ref('EnterpriseCorrectionReceipt')}}}};
    for(const code of [400,401,403,404,409,413,422,429,503])responses[String(code)]={description:'Error seguro. Una respuesta perdida después de commit requiere replay de la misma solicitud, no una nueva clave.',content:{'application/json':{schema:ref('Error')}}};
    api.paths[path]??={};api.paths[path][method]={operationId:id,'x-source-implemented':true,'x-runtime-enabled':false,'x-candidate-only':true,'x-required-scopes':method==='get'?['b2b:corrections:read','b2b:documents:read','b2b:corrections:write','b2b:documents:issue']:['b2b:corrections:write','b2b:documents:read','b2b:documents:issue'],
      description:'Perfil candidato F07/F08, original 01/PEN/0101/IGV18. Requiere grant vigente original–serie de nota y RUC explícito; notas B y lotes no habilitados. El propietario exige permisos de corrección e emisión también para consultar este productor.',security:[{B2bBearer:[],PrivateTransport:[]}],parameters:params,...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),responses};
  };
  add('post','/b2b/v1/correction-notes','b2bCreateEnterpriseCorrection','EnterpriseCorrectionCreate');
  add('get','/b2b/v1/correction-notes/{id}','b2bGetEnterpriseCorrection');
  add('post','/b2b/v1/correction-notes/{id}/settle','b2bSettleEnterpriseCorrection','EnterpriseCorrectionSettle');
  api.info.description='55 operaciones candidatas implementadas. Incluye NV/conversión local y productor empresarial F07/F08 con reservas dinámicas, journal verificable e idempotencia persistente. Sin despliegue Kong, envío oficial ni producción. RC/RA, notas B y perfiles no habilitados fallan cerrados.';
  return api;
}
