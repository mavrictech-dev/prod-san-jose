import {createRequire} from 'node:module';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const require=createRequire(new URL('../apps/web-pwa/package.json',import.meta.url));
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');

const state=vi.hoisted(()=>({workspace:{} as any,resource:{} as any,smtp:{} as any,paths:[] as string[]}));
vi.mock('../apps/web-pwa/features/workspace/provider',()=>({
 useWorkspace:()=>state.workspace,
 useResource:(path:string)=>{state.paths.push(path);return path.includes('/mail-settings/') ? state.smtp : state.resource;},
}));
vi.mock('../apps/web-pwa/features/b2b/admin-session-host',()=>({AdminSsoSessionHost:()=>null}));
import {ConfigurationOverview,IssuerCredentialSummary} from '../apps/web-pwa/features/b2b/configuration-overview';
import IntegrationsPage from '../apps/web-pwa/app/(workspace)/integrations/page';

beforeEach(()=>{
 state.smtp={data:{companyId:1,ruc:'20000000001',state:'EXTERNAL_SMTP_DISABLED',storageReady:false,encryption:'MISSING',approvedHostListConfigured:false,hostnameApproved:false,configured:false,credentialsConfigured:false,integrity:'NOT_CONFIGURED',readyToSend:false}};
 state.paths=[];state.resource={data:{ruc:'20000000001',environment:'BETA',certificate:{configured:true,expired:false},solConfigured:true,greConfigured:false}};
 state.workspace={companyId:'1',catalog:{companies:[{id:1,ruc:'20000000001',legalName:'EMISOR FICTICIO'}],branches:[{companyId:1},{companyId:2}],emissionPoints:[{companyId:1}]},can:()=>true};
});
describe('TI configuration overview',()=>{
 it('reads PRODUCTION metadata when that environment is selected for the issuer',()=>{
  state.workspace.catalog.companies[0].environment='PRODUCTION';state.resource.data.environment='PRODUCTION';
  const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(state.paths).toEqual(['/api/v1/setup/sunat/1/PRODUCTION','/api/v1/mail-settings/1']);
  expect(html).toContain('value="PRODUCTION" selected=""'); expect(html).toContain('Estado de credenciales PRODUCTION');
  expect(html).toContain('Guardarlos no activa el envío fiscal'); expect(html).toContain('guardado');
  expect(html).not.toContain('por el chat'); expect(html).not.toContain('Guía para TI');
 });
 it.each(['BETA','PRODUCTION'] as const)('uses only the explicit %s metadata and rejects the other environment', environment=>{
  state.resource.data.environment=environment;
  const props={company:state.workspace.catalog.companies[0],environment};
  let html=renderToStaticMarkup(React.createElement(IssuerCredentialSummary,props));
  expect(state.paths).toEqual(['/api/v1/setup/sunat/1/'+environment]); expect(html).toContain('Certificado:');
  state.resource.data.environment=environment==='BETA'?'PRODUCTION':'BETA';
  html=renderToStaticMarkup(React.createElement(IssuerCredentialSummary,props));
  expect(html).toContain('No se pudo confirmar'); expect(html).not.toContain('Certificado:');
 });
 it('keeps the primary credential shortcut hidden without its permission',()=>{
  state.workspace.user={scope:{kind:'GLOBAL'},roles:['ADMIN']};state.workspace.can=(permission:string)=>permission!=='sunat.configure';
  const html=renderToStaticMarkup(React.createElement(IntegrationsPage));
  expect(html).not.toContain('href="/sunat-settings"'); expect(state.paths).not.toContain('/api/v1/setup/sunat/1/BETA');
 });
 it('prioritizes B2B access with working section targets and keeps truthful notices',()=>{
  state.workspace.user={scope:{kind:'GLOBAL'},roles:['ADMIN']};
  const html=renderToStaticMarkup(React.createElement(IntegrationsPage));
  expect(html).toContain('Conexiones e integraciones');
  expect(html).toContain('aria-label="Accesos de conexiones"');
  for(const id of ['b2b-access','issuer-services']) {
   expect(html).toContain('href="#'+id+'"'); expect(html).toContain('id="'+id+'"');
  }
  expect(html.indexOf('id="b2b-access"')).toBeLessThan(html.indexOf('id="issuer-services"'));
  expect(html).not.toContain('href="/ti-guide"');
  expect(html).toContain('Gestionar RUC'); expect(html).toContain('Cargar credenciales');
  expect(html).toContain('value="BETA"'); expect(html).toContain('value="PRODUCTION"');
  expect(html).not.toContain('Configura cada empresa desde FactuEz');
  for(const notice of ['No compartas credenciales','Ingresa secretos desde HTTPS','Guardarlos no activa el envío fiscal','no acredita confianza','Envío externo deshabilitado','su propia sesión autorizada']) expect(html).toContain(notice);
 });
 it('shows the selected issuer and requests only its Beta metadata',()=>{
  const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(state.paths).toEqual(['/api/v1/setup/sunat/1/BETA','/api/v1/mail-settings/1']);expect(html).toContain('EMISOR FICTICIO');expect(html).toContain('Certificado:');expect(html).toContain('guardado');expect(html).toContain('1 sede y 1 punto');
  expect(html).toContain('/sunat-settings');expect(html).toContain('/mail-settings');expect(html).toContain('/received');
 });
 it('never displays status from a different issuer or environment',()=>{
  state.resource.data.ruc='20000000002';const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(html).toContain('No se pudo confirmar el emisor');expect(html).not.toContain('Certificado:');
  state.resource.data.ruc='20000000001';state.resource.data.environment='PRODUCTION';expect(renderToStaticMarkup(React.createElement(ConfigurationOverview))).not.toContain('Certificado:');
 });
 it('does not request fiscal metadata without fiscal permission or a selected company',()=>{
  state.workspace.can=(permission:string)=>permission!=='sunat.configure';const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(state.paths).toEqual(['/api/v1/mail-settings/1']);expect(html).not.toContain('href="/sunat-settings"');
  state.paths=[];state.workspace.can=()=>true;state.workspace.companyId='';renderToStaticMarkup(React.createElement(ConfigurationOverview));expect(state.paths).toHaveLength(0);
 });
 it('does not confuse an unavailable service with configured credentials',()=>{
  state.resource={error:'Unavailable'};const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(html).toContain('Estado de credenciales no disponible');expect(html).not.toContain('Certificado:');
 });
 it('does not render an incomplete response as a configured certificate',()=>{
  state.resource.data.certificate=undefined;expect(renderToStaticMarkup(React.createElement(ConfigurationOverview))).toContain('No se pudo confirmar');
 });
 it('shows actual SMTP blockers without settings or implying activation',()=>{
  state.smtp.data.settings={host:'do-not-render.example',password:'do-not-render-secret'};
  const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  for(const label of ['Almacenamiento pendiente','Cifrado pendiente o inválido','Lista de servidores aprobados pendiente','Configuración SMTP pendiente','Credenciales pendientes','Envío externo deshabilitado']) expect(html).toContain(label);
  expect(html).not.toContain('do-not-render');
 });
 it('does not infer readiness on errors, malformed or mismatched SMTP responses',()=>{
  state.smtp={error:'do-not-render-secret'};let html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(html).toContain('Estado SMTP no disponible');expect(html).not.toContain('do-not-render-secret');
  state.smtp={data:{companyId:2,ruc:'20000000001'}};html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(html).toContain('No se pudo confirmar el estado SMTP');expect(html).not.toContain('Sin pendientes en los indicadores');
 });
 it('does not request SMTP without email permission or a selected company',()=>{
  state.workspace.can=(permission:string)=>permission!=='document.email';let html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(state.paths).not.toContain('/api/v1/mail-settings/1');expect(html).not.toContain('href="/mail-settings"');
  state.paths=[];state.workspace.can=()=>true;state.workspace.companyId='';renderToStaticMarkup(React.createElement(ConfigurationOverview));expect(state.paths).toHaveLength(0);
 });
 it('reports only the supported SMTP indicators when locally prepared',()=>{
  Object.assign(state.smtp.data,{storageReady:true,encryption:'READY',approvedHostListConfigured:true,hostnameApproved:true,configured:true,credentialsConfigured:true,integrity:'VALID'});
  const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(html).toContain('Sin pendientes en los indicadores consultados');expect(html).toContain('Envío externo deshabilitado');
 });
 it('requires a global administrator with all administrative permissions before requesting statuses',()=>{
  for(const user of [undefined,{scope:{kind:'ASSIGNED'},roles:['ADMIN']},{scope:{kind:'GLOBAL'},roles:['USER']}]){
   state.workspace.user=user;state.paths=[];
   expect(renderToStaticMarkup(React.createElement(IntegrationsPage))).toContain('requiere un administrador general');expect(state.paths).toHaveLength(0);
  }
  state.workspace.user={scope:{kind:'GLOBAL'},roles:['ADMIN']};
  for(const missing of ['setup.manage','user.manage','role.manage']){
   state.workspace.can=(permission:string)=>permission!==missing;state.paths=[];
   expect(renderToStaticMarkup(React.createElement(IntegrationsPage))).toContain('requiere un administrador general');expect(state.paths).toHaveLength(0);
  }
  state.workspace.can=()=>true;expect(renderToStaticMarkup(React.createElement(IntegrationsPage))).toContain('Servicios por emisor');
 });
 it('does not claim that an unchecked integrity status is clear',()=>{
  Object.assign(state.smtp.data,{storageReady:true,encryption:'READY',approvedHostListConfigured:true,hostnameApproved:true,configured:true,credentialsConfigured:true,integrity:'NOT_CHECKED'});
  const html=renderToStaticMarkup(React.createElement(ConfigurationOverview));
  expect(html).toContain('Integridad de la configuración sin comprobar');expect(html).not.toContain('Sin pendientes en los indicadores consultados');
 });
});

