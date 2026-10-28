import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
const access=vi.hoisted(()=>({allowed:true,scope:'GLOBAL',roles:['ADMIN']}));
vi.mock('../apps/web-pwa/features/workspace/provider',()=>({useWorkspace:()=>({can:()=>access.allowed,setDirty:vi.fn(),user:{sub:'00000000-0000-4000-8000-000000000900',scope:{kind:access.scope},roles:access.roles}})}));
import {ShadowPanel,CaseDetail} from '../apps/web-pwa/features/shadow/panel';
import {ShadowLabWorkspace} from '../apps/web-pwa/features/shadow/workspace';
import {compareShadowRun} from '../packages/shadow-core/src';
import {createShadowPanelFixture} from '../packages/shadow-core/src/fixtures';
import {panelRows,type ShadowPanelData} from '../apps/web-pwa/features/shadow/model';
const webRequire=createRequire(new URL('../apps/web-pwa/package.json',import.meta.url)),React=webRequire('react'),{renderToStaticMarkup}=webRequire('react-dom/server');
const {AppRouterContext}=webRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const renderWorkspace=(d:ShadowPanelData)=>renderToStaticMarkup(React.createElement(AppRouterContext.Provider,{value:{refresh:vi.fn()}},React.createElement(ShadowLabWorkspace,{data:d})));
function data():ShadowPanelData{const f=createShadowPanelFixture();return {schemaVersion:'factuez.shadow-panel.v1',report:compareShadowRun(f),cases:f.cases};}
beforeEach(()=>{vi.stubGlobal('React',React);access.allowed=true;access.scope='GLOBAL';access.roles=['ADMIN'];});
afterEach(()=>vi.unstubAllGlobals());
describe('panel shadcn: render seguro y acceso restringido',()=>{
  it('renderiza resumen, filtros, tabla, botones y advertencias sin transmisión',()=>{const html=renderToStaticMarkup(React.createElement(ShadowPanel,{data:data(),reviewerId:'00000000-0000-4000-8000-000000000900'}));for(const text of ['Modo sombra','Informe JSON','CSV de la vista','Casos comparados','Diferencias pendientes','Buscar documento o cliente','Ver comparación FQ01-2','Coincide, sin verificar','Evidencia faltante','20','Producción y corte bloqueados','Anotaciones JSON'])expect(html).toContain(text);expect(html).not.toContain('Enviar a SUNAT');expect(html).not.toContain('Aceptado por SUNAT');});
  it('rechaza payload de producción sin renderizar ni exponer contenido',()=>{const d:any=structuredClone(data());d.report.environment='PRODUCTION';d.cases[0].legacy.snapshot.customer.legalName='NO_REVELAR';const html=renderToStaticMarkup(React.createElement(ShadowPanel,{data:d,reviewerId:'demo'}));expect(html).toContain('role="alert"');expect(html).not.toContain('NO_REVELAR');expect(html).not.toContain('Informe JSON');});
  it('escapa texto en vez de insertar HTML activo',()=>{const d=data();d.cases[0].legacy.snapshot.customer.legalName='<script>NO_EXEC</script>';const html=renderToStaticMarkup(React.createElement(ShadowPanel,{data:d,reviewerId:'demo'}));expect(html).toContain('&lt;script&gt;NO_EXEC&lt;/script&gt;');expect(html).not.toContain('<script>NO_EXEC');});
  it('detalle muestra diferencias, pestañas y su hash sin afirmar cierre',()=>{const row=panelRows(data())[1],html=renderToStaticMarkup(React.createElement(CaseDetail,{row,notes:[],editor:{differenceId:row.report.differences[0].id,category:'CORRECTION_REQUIRED',reason:''},onEditor:vi.fn(),onSave:vi.fn(),onRemove:vi.fn()}));for(const text of ['Datos e ítems','XML','Impresión y QR','Anotaciones','Diferencias del caso',row.report.inputSha256,'ninguna diferencia resuelta'])expect(html).toContain(text);});
  it.each(['permission','scope','role'])('perfil no autorizado %s no muestra panel',which=>{if(which==='permission')access.allowed=false;if(which==='scope')access.scope='ASSIGNED';if(which==='role')access.roles=['CASHIER'];const html=renderWorkspace(data());expect(html).toContain('requiere un administrador general');expect(html).not.toContain('shadow-panel');});
  it('administrador general ve el panel',()=>{expect(renderWorkspace(data())).toContain('shadow-panel');});
  it('ruta server sólo calcula fixture integrado; no conecta con Billing o SUNAT',()=>{const source=readFileSync(new URL('../apps/web-pwa/features/shadow/data.server.ts',import.meta.url),'utf8');expect(source).toContain("import 'server-only'");expect(source).toContain('createShadowPanelFixture()');for(const token of ['fetch(','process.env','Prisma','Outbox','certificate'])expect(source).not.toContain(token);const page=readFileSync(new URL('../apps/web-pwa/app/(workspace)/shadow-lab/page.tsx',import.meta.url),'utf8');expect(page).toContain("dynamic='force-dynamic'");});
  it('cliente no importa crypto/core en ejecución ni guarda borradores persistentes',()=>{for(const path of ['model.ts','panel.tsx']){const source=readFileSync(new URL(`../apps/web-pwa/features/shadow/${path}`,import.meta.url),'utf8');expect(source).not.toMatch(/import\s+\{[^}]*\}\s+from\s+['"]@factuez\/shadow-core/);for(const token of ['localStorage','indexedDB','fetch(','apiBlob('])expect(source).not.toContain(token);}});
});
