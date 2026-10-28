import {beforeAll,beforeEach,afterEach,describe,it,expect} from 'vitest';
import {request} from 'node:https';
import {createAdminBffServer} from '../services/b2b-api-service/src/admin-bff-http';
import {adminBffFixture} from './helpers/b2b-admin-bff.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {input} from './b2b-integration-admin.fixture';

const origin='https://factuez.test',base='/bff/b2b-admin',flowName='__Secure-factuez-b2b-admin-flow',sessionName='__Secure-factuez-b2b-admin';
describe('BFF browser HTTPS behind a registered mTLS edge → real Identity owner',()=>{
 let tls:ReturnType<typeof b2bCertificates>,f:ReturnType<typeof adminBffFixture>,server:ReturnType<typeof createAdminBffServer>,port:number;
 beforeAll(()=>{tls=b2bCertificates();},30000);
 beforeEach(async()=>{f=adminBffFixture(origin);server=createAdminBffServer(f.core,[fingerprint(tls.edge)],{ca:tls.ca,cert:tls.server,key:tls.key});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address() as {port:number}).port;});
 afterEach(async()=>{server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));});
 const call=(path:string,options:{method?:string;body?:unknown;cookie?:string;csrf?:string;origin?:string;host?:string;site?:string;cert?:Buffer|null;bearer?:string;workspaceLogout?:boolean}={})=>new Promise<any>((resolve,reject)=>{
  const bytes=options.body===undefined?undefined:Buffer.from(typeof options.body==='string'?options.body:JSON.stringify(options.body));
  // The synthetic edge verifies its fixed upstream TLS name and preserves the
  // approved browser Host separately, as the real Kong hop will do.
  const r=request({hostname:'127.0.0.1',servername:'localhost',port,path,method:options.method??'GET',ca:tls.ca,...(options.cert===null?{}:{cert:options.cert??tls.edge,key:tls.key}),rejectUnauthorized:true,agent:false,
   headers:{Host:options.host??'factuez.test',Origin:options.origin??origin,'Sec-Fetch-Site':options.site??'same-origin',...(options.workspaceLogout?{'X-FactuEz-Logout':'workspace'}:{}),...(options.cookie?{Cookie:options.cookie}:{}),...(options.csrf?{'X-FactuEz-CSRF':options.csrf}:{}),...(options.bearer?{Authorization:'Bearer '+options.bearer}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{})}},s=>{
    const chunks:Buffer[]=[];s.on('data',b=>chunks.push(b));s.on('error',reject);s.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:s.statusCode,headers:s.headers,text,body:text&&s.headers['content-type']?.startsWith('application/json')?JSON.parse(text):null});});
   });r.on('error',reject);r.end(bytes);
 });
 const cookie=(r:any,name:string)=>(r.headers['set-cookie']??[]).find((v:string)=>v.startsWith(name+'='))?.split(';')[0];
 async function login(){const start=await call(base+'/session/start',{method:'POST',body:{}});expect(start.status).toBe(200);const state=new URL(start.body.authorizeUrl).searchParams.get('state');const flow=cookie(start,flowName);const response=await call(base+'/callback?code=synthetic-valid-code&state='+state,{cookie:flow,site:'cross-site',origin:'https://synthetic-idp.invalid'});expect(response.status).toBe(303);const session=cookie(response,sessionName),status=await call(base+'/session',{cookie:session});expect(status.status).toBe(200);return {start,response,session,csrf:status.body.csrfToken,state,flow};}
 it('uses Secure HttpOnly cookies, one-use state/PKCE and a fixed callback redirect, keeping tokens server-side',async()=>{
  expect((await call(base+'/session')).body).toEqual({enabled:true,environment:'BETA',authenticated:false});const l=await login();
  for(const h of [...l.start.headers['set-cookie'],...l.response.headers['set-cookie']]){expect(h).toContain('HttpOnly');expect(h).toContain('Secure');expect(h).toContain('SameSite=Lax');expect(h).not.toContain('Domain=');}
  expect(l.response.headers.location).toBe(origin+'/integrations');expect(l.response.headers['referrer-policy']).toBe('no-referrer');expect(l.response.text).not.toContain(f.token);
  const again=await call(base+'/callback?code=synthetic-valid-code&state='+l.state,{cookie:l.flow});expect(again.status).toBe(303);expect(again.headers.location).toBe(origin+'/integrations?adminSso=failed');expect(f.provider.exchange).toHaveBeenCalledTimes(1);
 });
 it('creates and rotates through the existing owner with current CSRF; metadata cannot recover the secret',async()=>{
  const l=await login(),write={cookie:l.session,csrf:l.csrf};const created=await call(base+'/applications?environment=BETA',{...write,method:'POST',body:input()});expect(created.status).toBe(201);expect(created.body.clientSecret).toHaveLength(43);const id=created.body.application.id;
  const read=await call(base+'/applications/'+id+'?environment=BETA',write);expect(read.status).toBe(200);expect(read.body).not.toHaveProperty('clientSecret');expect(read.headers['cache-control']).toBe('private, no-store');
  const rotated=await call(base+'/applications/'+id+'/rotate-secret?environment=BETA',{...write,method:'POST',body:{expectedRevision:1}});expect(rotated.status).toBe(200);expect(rotated.body.application.revision).toBe(2);
  const stale=await call(base+'/applications/'+id+'?environment=BETA',{...write,method:'PATCH',body:{expectedRevision:1,enabled:false}});expect(stale.status).toBe(409);expect(stale.body).toEqual({code:'REVISION_CONFLICT'});
 });
 it.each(['missing-csrf','wrong-csrf','other-origin','cross-site','other-host','bearer','duplicate-query','duplicate-json'])('rejects %s without committing any client',async defect=>{
  const l=await login(),o:any={method:'POST',body:input(),cookie:l.session,csrf:l.csrf};let path=base+'/applications?environment=BETA';
  if(defect==='missing-csrf')delete o.csrf;if(defect==='wrong-csrf')o.csrf='bad';if(defect==='other-origin')o.origin='https://other.invalid';if(defect==='cross-site')o.site='cross-site';if(defect==='other-host')o.host='other.invalid';if(defect==='bearer')o.bearer='must-not-be-accepted';if(defect==='duplicate-query')path+='&environment=BETA';if(defect==='duplicate-json')o.body='{"label":"a","label":"b"}';
  const r=await call(path,o);expect([400,403]).toContain(r.status);expect(f.owner.store.clients.size).toBe(0);expect(r.text).not.toContain(f.token);
 });
 it('logs out server-side, clears cookies and refuses subsequent requests or changed live roles',async()=>{
  const l=await login();f.owner.state.active=false;expect((await call(base+'/applications?environment=BETA',{cookie:l.session,csrf:l.csrf})).status).toBe(403);f.owner.state.active=true;
  const out=await call(base+'/session/logout',{method:'POST',body:{},cookie:l.session,csrf:l.csrf});expect(out.body).toEqual({loggedOut:true});expect(out.headers['set-cookie'].every((h:string)=>h.includes('Max-Age=0'))).toBe(true);
  expect((await call(base+'/applications?environment=BETA',{cookie:l.session,csrf:l.csrf})).status).toBe(401);
 });
 it('rejects unknown peers and absent certificates; never returns a provider error body',async()=>{
  expect((await call(base+'/session',{cert:tls.other})).status).toBe(403);await expect(call(base+'/session',{cert:null})).rejects.toThrow();
  f.control.fail=true;const started=await call(base+'/session/start',{method:'POST',body:{}});const state=new URL(started.body.authorizeUrl).searchParams.get('state');const r=await call(base+'/callback?code=synthetic-valid-code&state='+state,{cookie:cookie(started,flowName)});expect(r.status).toBe(303);expect(r.headers.location).toBe(origin+'/integrations?adminSso=failed');expect(r.text).not.toContain('PRIVATE');
 });
 it('revokes after workspace navigation/reload without a panel CSRF, only for an explicit same-origin logout intent',async()=>{
  const l=await login();
  expect((await call(base+'/session/logout',{method:'POST',body:{},cookie:l.session})).status).toBe(403);
  expect((await call(base+'/session/logout',{method:'POST',body:{},cookie:l.session,workspaceLogout:true,origin:'https://outside.invalid'})).status).toBe(403);
  expect((await call(base+'/session/logout',{method:'POST',body:{},cookie:l.session,workspaceLogout:true,site:'cross-site'})).status).toBe(403);
  f.control.fail=true;
  const out=await call(base+'/session/logout',{method:'POST',body:{},cookie:l.session,workspaceLogout:true});expect(out.status).toBe(200);expect(out.body).toEqual({loggedOut:true});
  expect((await call(base+'/session/logout',{method:'POST',body:{},cookie:l.session,workspaceLogout:true})).status).toBe(200);
  f.control.fail=false;expect((await call(base+'/applications?environment=BETA',{cookie:l.session,csrf:l.csrf})).status).toBe(401);
 });
});
