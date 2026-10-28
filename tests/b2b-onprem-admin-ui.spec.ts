import {afterEach,describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {createOnpremBrowserClient,onpremApplicationTarget,type OnpremBrowserClient} from '../apps/web-pwa/features/b2b/onprem-admin-browser-client';
import {OnpremAdminSessionHost,explicitOnpremProfile} from '../apps/web-pwa/features/b2b/onprem-admin-session-host';
import {createIntegrationAdminPort} from '../apps/web-pwa/features/b2b/integration-admin-remote';
const require=createRequire(new URL('../apps/web-pwa/package.json',import.meta.url)),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const clients:OnpremBrowserClient[]=[];
const status=()=>({profile:'ONPREM',enabled:true,environment:'BETA',authenticated:false,csrfToken:'c'.repeat(43),expiresAt:new Date(Date.now()+120000).toISOString(),serviceOnly:true,readonly:true});
function fixture(){const api=vi.fn(),client=createOnpremBrowserClient(api as any);clients.push(client);return {client,api};}
afterEach(()=>{for(const c of clients.splice(0))c.close();vi.useRealTimers();});
describe('explicit OnPrem PWA integration uses the existing authorized workspace API',()=>{
 it('requires an explicit ONPREM profile and confirmed server enabled status; never interprets an SSO error',async()=>{
  expect(explicitOnpremProfile('ONPREM')).toBe(true);
  for(const v of ['SSO','onprem',undefined,404,503,{enabled:true}])expect(explicitOnpremProfile(v)).toBe(false);
  const {client,api}=fixture();api.mockResolvedValueOnce({enabled:true,authenticated:true});
  await expect(client.status()).rejects.toMatchObject({status:503});expect(client.getSnapshot().phase).toBe('error');
  api.mockResolvedValueOnce({profile:'ONPREM',enabled:false,environment:'BETA',authenticated:false});await client.status();
  expect(client.getSnapshot().phase).toBe('disabled');
  await expect(client.request('/b2b/v1/admin/applications?environment=BETA')).rejects.toMatchObject({status:403});
 });
 it('SSR renders no active management controls, password fields or network calls while off/unverified',()=>{
  const api=vi.fn();const html=renderToStaticMarkup(React.createElement(OnpremAdminSessionHost,{api}));
  expect(html).toContain('Verificando el perfil OnPrem');expect(html).not.toContain('Nueva integración');expect(html).not.toContain('type="password"');expect(api).not.toHaveBeenCalled();
 });
 it('posts native read/status requests with same-origin credentials and explicit CSRF; clears password after use',async()=>{
  const {client,api}=fixture(),s=status();api.mockResolvedValueOnce(s);await client.status();
  expect(client.getSnapshot().phase).toBe('password-required');
  api.mockResolvedValueOnce({profile:'ONPREM',authenticated:true,expiresAt:s.expiresAt});await client.reauthenticate('SYNTHETIC_PASSWORD');
  const req=api.mock.calls[1][1];expect(req.headers['X-FactuEz-CSRF']).toBe(s.csrfToken);expect(req.credentials).toBe('same-origin');expect(req.redirect).toBe('error');
  expect(JSON.stringify(client.getSnapshot())).not.toMatch(/SYNTHETIC_PASSWORD|cccccccc/);
  api.mockResolvedValueOnce({schemaVersion:'factuez.b2b.v1',source:'SOURCE',environment:'BETA',candidateOnly:true,items:[],nextAfter:null});
  const port=createIntegrationAdminPort(client);expect((await port.list({limit:25})).items).toEqual([]);
  expect(api.mock.calls[2][0]).toBe('/api/v1/b2b-admin/applications/query');
  expect(JSON.parse(api.mock.calls[2][1].body)).toEqual({environment:'BETA',limit:'25'});
 });
 it('never sends forbidden paths, USER or issue scopes to the native server',async()=>{
  const {client,api}=fixture(),s=status();api.mockResolvedValueOnce(s);await client.status();api.mockResolvedValueOnce({profile:'ONPREM',authenticated:true,expiresAt:s.expiresAt});await client.reauthenticate('SYNTHETIC_PASSWORD');
  const n=api.mock.calls.length;
  for(const path of ['https://evil.invalid','/internal/b2b/introspect?environment=BETA','/b2b/v1/admin/applications?environment=PRODUCTION','/b2b/v1/admin/applications?environment=BETA&environment=BETA'])
   await expect(client.request(path)).rejects.toMatchObject({status:400});
  await expect(client.request('/b2b/v1/admin/applications?environment=BETA',{method:'POST',body:{kind:'USER'}})).rejects.toMatchObject({status:400});
  await expect(client.request('/b2b/v1/admin/applications?environment=BETA',{method:'POST',body:{kind:'SERVICE',scopes:['b2b:documents:issue']}})).rejects.toMatchObject({status:400});
  expect(api.mock.calls.length).toBe(n);
 });
 it('expires without automatic reauth, drops pending secret replies on close and never retries mutations',async()=>{
  vi.useFakeTimers();const {client,api}=fixture(),s=status();api.mockResolvedValueOnce(s);await client.status();api.mockResolvedValueOnce({profile:'ONPREM',authenticated:true,expiresAt:s.expiresAt});await client.reauthenticate('SYNTHETIC_PASSWORD');
  let finish:(v:any)=>void=()=>{};api.mockReturnValueOnce(new Promise(r=>{finish=r;}));
  const pending=client.request('/b2b/v1/admin/applications/10000000-0000-4000-8000-000000000001/rotate-secret?environment=BETA',{method:'POST',body:{expectedRevision:1}});
  client.close();finish({clientSecret:'s'.repeat(43)});await expect(pending).rejects.toMatchObject({status:401});expect(api).toHaveBeenCalledTimes(3);
  const f=fixture();f.api.mockResolvedValueOnce(status());await f.client.status();await vi.advanceTimersByTimeAsync(120001);
  expect(f.client.getSnapshot().phase).toBe('expired');expect(f.api).toHaveBeenCalledTimes(1);
 });
});
