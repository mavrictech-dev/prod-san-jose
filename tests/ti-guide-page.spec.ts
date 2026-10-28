import {createRequire} from 'node:module';
import {describe,it,expect,vi} from 'vitest';
const require=createRequire(new URL('../apps/web-pwa/package.json',import.meta.url));
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const state=vi.hoisted(()=>({workspace:{} as any}));
vi.mock('../apps/web-pwa/features/workspace/provider',()=>({useWorkspace:()=>state.workspace}));
import TiGuidePage from '../apps/web-pwa/app/(workspace)/ti-guide/page';
describe('guía TI en la aplicación',()=>{
 it('muestra los pasos y el botón de PDF para administrador general autorizado',()=>{
  state.workspace={user:{scope:{kind:'GLOBAL'},roles:['ADMIN']},can:()=>true};
  const html=renderToStaticMarkup(React.createElement(TiGuidePage));
  for(const text of ['Guía para el responsable de TI','Guardar como PDF / Imprimir','Empresas, sedes y series','Certificado y credenciales SUNAT','Recepción de compras','Correo saliente','Acceso de otras aplicaciones','Historial y puesta en marcha'])expect(html).toContain(text);
  for(const route of ['/stations','/sunat-settings','/received','/mail-settings','/integrations'])expect(html).toContain(`href="${route}"`);
  expect(html).toContain('no los activa');
 });
 it('bloquea a usuarios sin rol o permisos administrativos',()=>{
  for(const user of [null,{scope:{kind:'ASSIGNED'},roles:['ADMIN']},{scope:{kind:'GLOBAL'},roles:['USER']}]){
   state.workspace={user,can:()=>true};expect(renderToStaticMarkup(React.createElement(TiGuidePage))).toContain('requiere un administrador general');
  }
  state.workspace={user:{scope:{kind:'GLOBAL'},roles:['ADMIN']},can:(p:string)=>p!=='setup.manage'};
  expect(renderToStaticMarkup(React.createElement(TiGuidePage))).not.toContain('Guardar como PDF');
 });
});
