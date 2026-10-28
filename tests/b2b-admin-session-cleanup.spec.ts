import {afterEach,describe,it,expect,vi} from 'vitest';
import {clearAdminSessionFromWorkspace} from '../apps/web-pwa/features/b2b/admin-session-cleanup';
afterEach(()=>vi.unstubAllGlobals());
describe('workspace logout cleanup independent of the admin panel',()=>{
 it('is safe during server rendering and unit sessions without window',()=>{vi.stubGlobal('window',undefined);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);expect(()=>clearAdminSessionFromWorkspace()).not.toThrow();expect(fetch).not.toHaveBeenCalled();});
 it('notifies in-memory panels and revokes the opaque cookie with a fixed keepalive request after reload',async()=>{
  const dispatchEvent=vi.fn(),cancel=vi.fn(),fetch=vi.fn(async(_path:string,_init:any)=>({body:{cancel}}));vi.stubGlobal('window',{location:{protocol:'https:'},dispatchEvent});vi.stubGlobal('fetch',fetch);
  clearAdminSessionFromWorkspace();await Promise.resolve();expect(dispatchEvent.mock.calls[0][0].type).toBe('factuez:workspace-logout');
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/bff/b2b-admin/session/logout',expect.objectContaining({method:'POST',body:'{}',keepalive:true,credentials:'same-origin',redirect:'error',headers:expect.objectContaining({'X-FactuEz-Logout':'workspace'})}));expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');expect(cancel).toHaveBeenCalled();
 });
 it.each(['throw','reject'])('does not block the ordinary logout when the BFF network %s fails',async mode=>{
  vi.stubGlobal('window',{location:{protocol:'https:'},dispatchEvent:vi.fn()});vi.stubGlobal('fetch',vi.fn(()=>{if(mode==='throw')throw Error('OFFLINE');return Promise.reject(Error('OFFLINE'));}));expect(()=>clearAdminSessionFromWorkspace()).not.toThrow();await Promise.resolve();await Promise.resolve();
 });
 it('never falls back to transmitting the cookie over HTTP',()=>{const dispatchEvent=vi.fn(),fetch=vi.fn();vi.stubGlobal('window',{location:{protocol:'http:'},dispatchEvent});vi.stubGlobal('fetch',fetch);clearAdminSessionFromWorkspace();expect(dispatchEvent).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();});
});
