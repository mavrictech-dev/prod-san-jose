import 'reflect-metadata';
import {describe,expect,it,vi} from 'vitest';
import {GUARDS_METADATA} from '../services/sunat-service/node_modules/@nestjs/common/constants';
import {fiscalRuntimeOpenApi,FiscalRuntimeOpenApiController} from '../services/sunat-service/src/runtime-openapi.controller';
import {ConfigurationGuard} from '../services/sunat-service/src/auth/configuration.guard';
import {privateSwaggerDocument} from '../apps/web-pwa/features/api-docs/private-viewer';
import vm from 'node:vm';
describe('Private administrative OpenAPI is independent from public B2B documentation',()=>{
 it('requires the current global admin configuration guard on its controller',()=>{
  expect(Reflect.getMetadata(GUARDS_METADATA,FiscalRuntimeOpenApiController)).toEqual([ConfigurationGuard]);
 });
 it('documents concrete fiscal operations and explicit receipt opt-in without secrets or private owner RPCs',()=>{
  const spec=fiscalRuntimeOpenApi();expect(spec.openapi).toBe('3.1.0');expect(JSON.stringify(spec)).not.toContain('/internal/');
  const ids:string[]=[];for(const [path,methods] of Object.entries(spec.paths))for(const operation of Object.values(methods)){
   const expectedSecurity=path==='/api/v1/auth/login'||path==='/api/v1/auth/browser-session/login'?[]
    :path==='/api/v1/auth/browser-session/logout'?[{},{NativeBrowserSessionCookie:[]}]
    :path.startsWith('/api/v1/auth/browser-session')?[{NativeBrowserSessionCookie:[]}]:[{HumanSessionBearer:[]}];
   expect(operation.security).toEqual(expectedSecurity);ids.push(operation.operationId);
  }
  expect(new Set(ids).size).toBe(ids.length);
  expect(spec.paths).not.toHaveProperty('/api/v1/setup/sunat/{companyId}/PRODUCTION/admission');
  const dispatch=spec.paths['/api/v1/setup/sunat/{companyId}/PRODUCTION/dispatch'].post;
  expect(dispatch.requestBody.content['application/json'].schema.properties).toHaveProperty('authorizedDocumentTypes');
  expect(spec.paths['/api/v1/mail-settings/{companyId}/dry-run'].post.requestBody.content['application/json'].schema.properties).toEqual({});
  expect(spec.paths['/api/v1/mail-settings/{companyId}/send-test'].post.parameters.some((p:any)=>p.name==='Idempotency-Key')).toBe(true);
  expect(spec.paths['/api/v1/mail-settings/{companyId}/send-document'].post.parameters.some((p:any)=>p.name==='Idempotency-Key')).toBe(true);
  expect(spec.paths['/api/v1/documents/{originalId}/production-notes'].post.requestBody.content['application/json'].schema.properties).not.toHaveProperty('customer');
  expect(JSON.stringify(spec)).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY|secretHash|configurationCipher/);
 });
 it('documents DOCUMENT for accepted own Production 01/03/07/08, exact attachments and unchanged explicit grants',()=>{
  const paths=fiscalRuntimeOpenApi().paths;
  const status=paths['/api/v1/mail-settings/{companyId}/documents/{documentId}'].get;
  const activation=paths['/api/v1/mail-settings/{companyId}/document-activation'].post;
  const send=paths['/api/v1/mail-settings/{companyId}/send-document'].post;
  for(const operation of [status,activation,send]){
   expect(operation.description).toMatch(/factura[s]? 01/i);expect(operation.description).toMatch(/boleta[s]? 03/i);
   expect(operation.description).toMatch(/nota[s]? de crédito 07/i);expect(operation.description).toMatch(/nota[s]? de débito 08/i);
   expect(operation.description).toContain('Producción');expect(operation.description).toMatch(/propia[s]?/);
   expect(operation.security).toEqual([{HumanSessionBearer:[]}]);
  }
  for(const operation of [status,send]){
   expect(operation.description).toContain('ADMIN GLOBAL');expect(operation.description).toContain('ACCEPTED o ACCEPTED_WITH_OBSERVATIONS');
  }
  expect(status.description).toContain('document.email');expect(status.description).toContain('No descarga adjuntos ni envía mensajes al consultar');
  expect(activation.description).toContain('independiente de las pruebas SMTP y ligada a la revisión exacta');
  expect(activation.description).toContain('No concede B2B ni envía un comprobante por sí sola');
  expect(send.description).toContain('PDF actual, XML firmado, ZIP de envío, CDR XML y CDR ZIP originales');
  expect(send.description).toContain('Para factura 01 y notas 07/08, el ZIP y CDR corresponden al comprobante individual.');
  expect(send.description).toContain('Para boleta 03, el ZIP y CDR corresponden al resumen RC vinculado.');
  expect(send.description).toContain('No se generan originales nuevos');expect(send.description).toContain('no concede B2B');
  expect(send.description).toContain('HANDED_OFF significa aceptado por SMTP, sin confirmar entrega al destinatario');
  expect(send.description).toContain('UNKNOWN no se reenvía automáticamente');
  expect(send.parameters).toContainEqual({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',format:'uuid'}});
  const schema=(operation:any)=>operation.requestBody.content['application/json'].schema;
  expect(schema(activation)).toEqual({type:'object',additionalProperties:false,required:['expectedRevision','expectedActivationRevision','enabled','confirmed'],properties:{
   expectedRevision:{type:'integer',minimum:1},expectedActivationRevision:{type:'integer',minimum:0},enabled:{type:'boolean'},confirmed:{type:'boolean',const:true}}});
  expect(schema(send).required).toEqual(['expectedRevision','expectedActivationRevision','documentId','format','recipient','confirmed']);
  expect(schema(send).additionalProperties).toBe(false);expect(schema(send).properties.confirmed).toEqual({type:'boolean',const:true});
  expect(schema(send).properties.format.enum).toEqual(['a4','ticket']);expect(schema(send).properties.recipient).toEqual({type:'string',format:'email'});
  expect(schema(send).properties.expectedRevision).toEqual({type:'integer',minimum:1});expect(schema(send).properties.expectedActivationRevision).toEqual({type:'integer',minimum:1});
 });
 it('embeds no token and never executes or persists requests; malicious spec text cannot close a script',()=>{
  const html=privateSwaggerDocument({info:{title:'</script><script>alert(1)</script>'}},'11111111-1111-4111-8111-111111111111');
  expect(html).not.toContain('<script>alert');expect(html).toContain("connect-src 'none'");
  let captured:any;const context={SwaggerUIBundle:(value:any)=>{captured=value;},Error};
  const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]).filter(Boolean);
  expect(scripts).toHaveLength(1);vm.runInNewContext(scripts[0],context);
  expect(captured.supportedSubmitMethods).toEqual([]);expect(captured.tryItOutEnabled).toBe(false);
  expect(captured.persistAuthorization).toBe(false);expect(captured.queryConfigEnabled).toBe(false);
  expect(captured.validatorUrl).toBeNull();expect(()=>captured.requestInterceptor({url:'https://elsewhere.invalid'})).toThrow('sólo lectura');
  expect(captured.spec.info.title).toBe('</script><script>alert(1)</script>');
  expect(()=>privateSwaggerDocument({},'bad\"nonce')).toThrow('Nonce');
 });
});
