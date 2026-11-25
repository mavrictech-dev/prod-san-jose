export interface ApiFieldIssue {field:string;code:string;message:string}
export interface ApiProblem {statusCode:number;code:string;message:string;requestId:string;errors:ApiFieldIssue[];fieldErrors:Record<string,string>;retryable:boolean}
const descriptions:Record<string,[string,string]>={
 COMMAND_REJECTED:['Idempotency-Key','La operación anterior fue rechazada antes de registrar el documento. Corrija los datos y use una clave nueva.'],
 PRODUCTION_SERVER_DISABLED:['configuration','Los envíos reales a SUNAT están deshabilitados en el servidor. La configuración guardada se conserva.'],
 PRODUCTION_AUTHORIZATION_REQUIRED:['configuration','Revise la autorización del RUC, sus tipos permitidos y la revisión del certificado vigente.'],
 invalid_client:['authorization','El Client ID o Client Secret no son válidos, o la aplicación está deshabilitada.'],
 invalid_scope:['scope','Uno de los permisos solicitados no está asignado a esta aplicación. Consulte los permisos registrados por el administrador.'],
 unsupported_grant_type:['grant_type','Use grant_type=client_credentials para autenticar una aplicación.'],
 invalid_request:['request','Revise los campos obligatorios y su formato según la documentación de OAuth.'],
 NATIVE_UUID_BINDING_REQUIRED:['binding','La sede y el punto deben ser UUID obtenidos de los catálogos; no sus códigos o nombres.'],
 NATIVE_B2B_DISABLED:['configuration','La API B2B nativa no está habilitada en esta instalación.'],
 ADMIN_SCOPE_REQUIRED:['authorization','La gestión de aplicaciones requiere administrador general con permisos de configuración, usuarios y roles.'],
 INVALID_BINDING:['binding','Seleccione un RUC, sede, punto y serie válidos.'],
 NATIVE_BINDING_DENIED:['binding','El RUC, sede, punto o serie no están activos en Producción o no pertenecen a esta aplicación.'],
 INSUFFICIENT_SCOPE:['authorization','La aplicación no tiene el permiso requerido para este RUC, sede, punto y serie.'],
 REVOKED_TOKEN:['authorization','El acceso de la aplicación cambió o fue revocado. Obtenga un nuevo token.'],
 INVALID_TOKEN:['authorization','El token falta, venció o no es válido. Obtenga un nuevo token.'],
 OWNER_UNRESOLVED:['operation','Esta operación todavía no está instalada en el servidor. Consulte las capacidades de la API.'],
 IDEMPOTENCY_KEY_REQUIRED:['Idempotency-Key','Envíe una clave de idempotencia de 1 a 100 letras, números, guiones o guiones bajos.'],
 IDEMPOTENCY_CONFLICT:['Idempotency-Key','Esta clave ya se usó con otros datos. Consulte la operación original antes de corregir o enviar otra solicitud.'],
 COMMAND_PENDING:['Idempotency-Key','La operación sigue en curso. Consulte su estado; no genere una nueva clave para repetirla.'],
 COMMAND_UNCERTAIN:['Idempotency-Key','No se pudo confirmar el resultado de la operación. Requiere consultar y conciliar el estado; no se reenvía automáticamente.'],
 PAYLOAD_BINDING_MISMATCH:['binding','La serie, el punto o el tipo del documento no coinciden con el permiso de la aplicación.'],
 NOTE_ORIGINAL_BINDING_MISMATCH:['originalId','El documento original no pertenece al RUC, sede y punto autorizados.'],
 GRE_GRANT_REQUIRED:['seriesCounterId','La serie requiere una autorización GRE vigente para este actor y perfil.'],
 GRE_REFERENCE_REQUIRED:['body.reference09','Seleccione una guía remitente 09 aceptada para crear la guía transportista.'],
 GRE_REFERENCE_MISMATCH:['body.reference09','Los datos del traslado no coinciden con la guía remitente aceptada.'],
 GRE_CONFIG_FILE_REQUIRED:['configuration','La identidad interna GRE no está instalada. Ejecute la preparación GRE conservando las claves existentes.'],
};
export function explainApiCode(code:string):ApiFieldIssue|undefined {const value=descriptions[code];return value?{field:value[0],code,message:value[1]}:undefined;}
export function apiProblem(input:{status:number;code:string;message?:string;requestId:string;errors?:ApiFieldIssue[];fieldErrors?:Record<string,string>}):ApiProblem{
 const explained=explainApiCode(input.code),issues=(input.errors?.length?input.errors:explained?[explained]:[]).slice(0,100);
 const fields:Record<string,string>=Object.create(null);
 for(const [field,message] of Object.entries(input.fieldErrors??{})){if(typeof message==='string'&&field.length<=160)fields[field]=message.slice(0,600);}
 for(const issue of issues)fields[issue.field]=issue.message;
 return {statusCode:input.status,code:input.code,message:input.message??explained?.message??(input.status>=500?'El servicio no está disponible. Conserve el identificador de solicitud para revisar el error.':'Revise los datos y permisos de la solicitud.'),requestId:input.requestId,errors:issues,fieldErrors:fields,retryable:[429,503,504].includes(input.status)};
}
