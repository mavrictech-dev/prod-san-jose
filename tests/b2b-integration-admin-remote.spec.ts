import {describe,it,expect,vi} from 'vitest';
import {createIntegrationAdminPort} from '../apps/web-pwa/features/b2b/integration-admin-remote';
import {binding,id} from './b2b-identity.fixture';
const application={id:id(2),label:'INTEGRACION FICTICIA',kind:'SERVICE' as const,enabled:true,revision:1,oidcClientId:null,scopes:['b2b:context:read'],bindings:[binding]};
const wrap=(v:any)=>({schemaVersion:'factuez.b2b.v1',source:'SOURCE',environment:'BETA',candidateOnly:true,...v});
describe('browser session-bound admin adapter, no token/session acquisition',()=>{
 it('maps the actual source envelope and live cursor to the panel contract',async()=>{
  const request=vi.fn(async()=>wrap({items:[application],nextAfter:application.id})),port=createIntegrationAdminPort({request:request as any});
  expect(await port.list({limit:1})).toMatchObject({items:[application],nextAfter:application.id,hasMore:true});
  expect(request).toHaveBeenCalledWith('/b2b/v1/admin/applications?environment=BETA&limit=1');
 });
 it('only returns a one-time create secret from the explicit confirmed operation',async()=>{
  const secret='a'.repeat(43),request=vi.fn(async()=>wrap({application,clientSecret:secret})),port=createIntegrationAdminPort({request:request as any});
  expect(await port.create({label:application.label,kind:'SERVICE',scopes:application.scopes,bindings:application.bindings})).toEqual({client:application,clientSecret:secret});
  request.mockImplementation(async()=>wrap({application}));expect(await port.read(application.id)).toEqual(application);
  request.mockImplementation(async()=>wrap({application,clientSecret:secret}));await expect(port.read(application.id)).rejects.toMatchObject({code:'INVALID_ADMIN_RESPONSE'});
 });
 it('does not accept a leaked hash, production response or foreign target',async()=>{
  const request=vi.fn(async()=>wrap({application:{...application,secretHash:'private'}})),port=createIntegrationAdminPort({request:request as any});
  await expect(port.read(application.id)).rejects.toMatchObject({code:'INVALID_ADMIN_RESPONSE'});
  request.mockImplementation(async()=>({...wrap({application}),environment:'PRODUCTION'}));await expect(port.read(application.id)).rejects.toMatchObject({code:'INVALID_ADMIN_RESPONSE'});
  request.mockImplementation(async()=>wrap({application:{...application,id:id(3)}}));await expect(port.read(application.id)).rejects.toMatchObject({code:'INVALID_ADMIN_RESPONSE'});
 });
 it('keeps server revision conflicts intact and denies stale mutation receipts',async()=>{
  const request=vi.fn(async()=>{throw {status:409,code:'REVISION_CONFLICT'};}),port=createIntegrationAdminPort({request:request as any});
  await expect(port.update(application.id,{expectedRevision:1,enabled:false})).rejects.toMatchObject({status:409});
  request.mockImplementation(async()=>wrap({application}) as never);await expect(port.update(application.id,{expectedRevision:1,enabled:false})).rejects.toMatchObject({code:'INVALID_ADMIN_RESPONSE'});
 });
});
