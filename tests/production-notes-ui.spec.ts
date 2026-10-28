import {createRequire} from 'node:module';
import {afterEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({can:true,admin:true,resource:vi.fn(),api:vi.fn()}));
vi.mock('../apps/web-pwa/features/workspace/provider',()=>({
 ApiError:class extends Error{constructor(message:string,public status:number){super(message);}},
 useWorkspace:()=>({can:()=>state.can,user:{sub:'synthetic-admin',roles:state.admin?['ADMIN']:['CASHIER'],scope:{kind:state.admin?'GLOBAL':'ASSIGNED'}},api:state.api,catalog:{companies:[{id:1,ruc:'00000000001',environment:'PRODUCTION'}]}}),
 useResource:(...args:unknown[])=>state.resource(...args),
}));
import {productionNoteCommand,productionNotePreview,ProductionNotesPanel} from '../apps/web-pwa/features/workspace/production-notes';
import {ProductionNotesActivation} from '../apps/web-pwa/features/workspace/production-notes-activation';
const req=createRequire(new URL('../apps/web-pwa/package.json',import.meta.url)),React=req('react'),{renderToStaticMarkup}=req('react-dom/server');
const id='10000000-0000-4000-8000-000000000001';
afterEach(()=>{state.can=true;state.admin=true;vi.clearAllMocks();});
describe('production note operator controls and exact decimal preview',()=>{
 it('submits only series and adjustment; source quantity, original totals and customer cannot be supplied by the form',()=>{
  expect(productionNoteCommand(id,'07',' Anulación solicitada ',{'1':'100'})).toEqual({seriesCounterId:id,adjustment:{documentTypeCode:'07',reasonCode:'01',reasonDescription:'Anulación solicitada'}});
  expect(productionNoteCommand(id,'08','Ajuste de precio',{'1':'0.18','2':''})).toEqual({seriesCounterId:id,adjustment:{documentTypeCode:'08',reasonCode:'02',reasonDescription:'Ajuste de precio',lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'0.18'}]}});
 });
 it.each(['0','-1','1,18','0.0000001','1e2','NaN','01.00'])('refuses invalid or zero increment %s before submit',value=>{
  expect(()=>productionNoteCommand(id,'08','Ajuste',{'1':value})).toThrow();
 });
 it('calculates rounded line amounts and IGV with the same decimal algorithm used by the owner',()=>{
  const lines=[{lineNumber:1,description:'Synthetic',quantity:'5.707',unitCode:'GLL',unitPriceWithTax:'18.00',totalAmount:'102.73'}];
  expect(productionNotePreview(lines,{'1':'0.18'})).toEqual({taxableAmount:'0.87',igvAmount:'0.16',payableAmount:'1.03'});
  expect(()=>productionNotePreview(lines,{'2':'1.18'})).toThrow('fuera');
  expect(()=>productionNotePreview([{...lines[0],quantity:'0.000001'}],{'1':'0.000001'})).toThrow('mayor que cero');
 });
 it('does not fetch note preparation without permission to issue',()=>{
  state.can=false;expect(renderToStaticMarkup(React.createElement(ProductionNotesPanel,{documentId:id}))).toBe('');expect(state.resource).not.toHaveBeenCalled();expect(state.api).not.toHaveBeenCalled();
 });
 it('renders a disabled preparation form and no confirmation dialog when the server is disabled',()=>{
  state.resource.mockReturnValue({data:{serverEnabled:false,original:{documentId:id,fullNumber:'F001-1',lines:[],totals:{payableAmount:'1.18'}},series:[]},reload:vi.fn()});
  const html=renderToStaticMarkup(React.createElement(ProductionNotesPanel,{documentId:id}));expect(html).toContain('no está habilitada');expect(html).toContain('No hay una serie activa');expect(html).toMatch(/disabled[^>]*>Revisar nota/);expect(html).not.toContain('Confirmar y emitir');expect(state.api).not.toHaveBeenCalled();
 });
 it('a disabled server cannot render active authorization controls or issue an activation',()=>{
  state.resource.mockReturnValue({data:{issuerRuc:'00000000001',profile:'PROFILE',version:0,credentialRevision:0,serverEnabled:false,enabled:false},reload:vi.fn()});
  const html=renderToStaticMarkup(React.createElement(ProductionNotesActivation,{companyId:1}));expect(html).toContain('no habilitadas en este servidor');expect(html).toMatch(/disabled[^>]*>Autorizar notas/);expect(state.api).not.toHaveBeenCalled();
 });
});
