/** Standalone OpenAPI 3.1 paths for Main's administration aggregator.
 * Pure metadata: no imports from runtime services, credentials or environment. */
export function productionReceivedOpenApiPaths() {
  const base='/api/v1/received-documents/automation';
  const ruc={type:'string',pattern:'^\\d{11}$',description:'RUC exacto del destinatario autorizado en el catálogo.'};
  const revision={type:'integer',minimum:1,maximum:2147483646};
  const uuid={type:'string',format:'uuid'};
  const date={type:'string',format:'date-time'};
  const boolean={type:'boolean'};
  const checks={type:'object',additionalProperties:false,required:['database','encryption','externalReadAllowed'],properties:{database:boolean,encryption:boolean,externalReadAllowed:boolean}};
  const resultProperties={recipientRuc:ruc,ready:boolean,serverReady:boolean,mail:{type:'string',enum:['DISABLED','NOT_VALIDATED','VALID','CONNECTION_REJECTED']},sire:{type:'string',enum:['DISABLED','NOT_VALIDATED','VALID','CONNECTION_REJECTED']}};
  const result={type:'object',additionalProperties:false,required:Object.keys(resultProperties),properties:resultProperties};
  const readiness={type:'object',additionalProperties:false,required:['checks','ready','externalDefault','sireProvides','xmlDetailSource','companyId','recipientRuc','revision','activated','validation','reviewVersion','review'],properties:{
    checks,ready:{...boolean,description:'Preparación local del servidor; no acredita conexión LIVE ni autorización de un RUC.'},
    externalDefault:{type:'string',const:'OFF_UNTIL_RUC_CONFIRMED'},sireProvides:{type:'string',const:'PURCHASE_REGISTRY_TOTALS'},xmlDetailSource:{type:'string',const:'PROVIDER_MAIL_ATTACHMENTS'},
    companyId:{type:'integer',minimum:1},recipientRuc:ruc,revision:{type:'integer',minimum:0},activated:boolean,
    validation:{oneOf:[{type:'null'},{type:'object',additionalProperties:false,required:['id','revision','createdAt','result'],properties:{id:uuid,revision,createdAt:date,result}}]},
    reviewVersion:{type:'string',const:'RECEIVED_READ_ONLY_V1'},review:{type:'array',items:{type:'string'}}}};
  const parameter={name:'companyId',in:'query',required:true,schema:{type:'integer',minimum:1},description:'Empresa destinataria accesible para esta sesión; no es un parámetro de ruta.'};
  const response=(description:string,schema:unknown={type:'object'})=>({description,content:{'application/json':{schema}}});
  const errors={400:response('Cuerpo, RUC, confirmación o versión de revisión inválidos'),401:response('Sesión humana requerida'),403:response('Requiere administrador GLOBAL con setup.manage y empresa autorizada'),409:response('Configuración o revisión cambió; validación ausente, fallida o vencida; servidor pendiente'),503:response('Infraestructura o integridad de credenciales no disponible')};
  const operation=(operationId:string,summary:string,description:string)=>({operationId,summary,description,tags:['Recepción automática de proveedores'],security:[{HumanSessionBearer:[]}],parameters:[parameter]});
  const body=(properties:Record<string,unknown>)=>({required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:Object.keys(properties),properties}}}});
  return {
    [base+'/readiness']:{get:{...operation('readProductionReceivedReadiness','Consultar preparación de recepción por RUC','Sólo consulta metadatos y preparación local de BD/cifrado/permiso del servidor. No abre conexiones SIRE/IMAP ni activa recepción. La última validación pertenece a la revisión indicada y puede estar vencida; activate comprueba el plazo de 15 minutos. No devuelve secretos. SIRE aporta registros y totales; XML, CDR y detalle proceden de adjuntos del proveedor.'),responses:{200:response('Preparación local, revisión, autorización y última validación guardada',readiness),...errors}}},
    [base+'/validate']:{post:{...operation('validateProductionReceivedConnection','Validar credenciales de recepción de esta revisión','Acción explícita del administrador: comprueba preparación del servidor y autentica los conectores habilitados con TLS estricto, DNS público y hosts aprobados. SIRE valida autenticación; correo abre la carpeta con EXAMINE en lectura. No importa documentos, no presenta libros y no activa el scheduler. Guarda el resultado sin secretos y entrega validationId ligado a RUC/revisión por 15 minutos. Un rechazo de conexión queda en ready=false con estado CONNECTION_REJECTED; no se representa como éxito LIVE.'),requestBody:body({expectedRevision:revision,recipientRuc:ruc}),responses:{201:response('Resultado guardado; ready indica si puede solicitar activación',{type:'object',additionalProperties:false,required:['validationId','revision',...Object.keys(resultProperties),'expiresAt'],properties:{validationId:uuid,revision,...resultProperties,expiresAt:date}}),...errors}}},
    [base+'/activate']:{post:{...operation('activateProductionReceivedReadOnly','Confirmar y activar lectura periódica para este RUC','Exige validationId exitoso de la misma revisión/RUC y no mayor a 15 minutos, infraestructura lista y confirmación igual al RUC destinatario. reviewVersion debe ser RECEIVED_READ_ONLY_V1. Activa sólo la configuración de esta empresa; guardar cualquier cambio posterior, incluidas credenciales, desactiva su autorización. No presenta libros ni acepta propuestas. La habilitación del servidor por sí sola no activa empresas nuevas.'),requestBody:body({expectedRevision:revision,recipientRuc:ruc,validationId:uuid,confirmation:{...ruc,description:'Debe coincidir exactamente con recipientRuc.'},reviewVersion:{type:'string',const:'RECEIVED_READ_ONLY_V1'}}),responses:{201:response('Autorización registrada; devuelve readiness actual',readiness),...errors}}},
  };
}
