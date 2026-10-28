import {createServer} from 'node:https';
import type {IncomingMessage as HttpRequest,ServerResponse as HttpResponse} from 'node:http';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {AdminSessionBff} from './admin-bff-core';
import {adminBffOpaque} from './admin-bff-store';

const BASE='/bff/b2b-admin',COOKIE='__Secure-factuez-b2b-admin',FLOW=COOKIE+'-flow';
const safeCodes=new Set(['ADMIN_SESSION_REQUIRED','ADMIN_BFF_DISABLED','ADMIN_BFF_UNAVAILABLE','INVALID_BROWSER_REQUEST','INVALID_BROWSER_BODY','INVALID_SSO_CALLBACK','BROWSER_ORIGIN_REQUIRED','CSRF_REQUIRED','RATE_LIMITED','RESOURCE_NOT_FOUND','INVALID_ADMIN_REQUEST','INVALID_TOKEN','STEP_UP_REQUIRED','FORBIDDEN','ADMIN_ACCESS_DENIED','REVISION_CONFLICT','INVALID_REQUEST','INVALID_QUERY','INVALID_SCOPE','INVALID_BINDINGS','CLIENT_KIND_NOT_ALLOWED']);
function fail(status:number,code:string):never{throw new B2bSecurityError(status,code);}
function cookie(req:HttpRequest,name:string){const raw=req.headers.cookie;if(raw===undefined)return undefined;if(typeof raw!=='string'||raw.length>8192)fail(400,'INVALID_BROWSER_REQUEST');const values=raw.split(';').map(x=>x.trim()).filter(x=>x.split('=')[0]===name);if(!values.length)return undefined;if(values.length!==1)fail(400,'INVALID_BROWSER_REQUEST');const value=values[0].slice(name.length+1);if(!adminBffOpaque(value))fail(401,'ADMIN_SESSION_REQUIRED');return value;}
function setCookie(name:string,value:string,seconds:number){return `${name}=${value}; Path=${BASE}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0,Math.floor(seconds))}`;}
function strictJson(source:string){
 const value=JSON.parse(source),stack:({object:true;keys:Set<string>;key:boolean}|{object:false})[]=[];
 for(let i=0;i<source.length;i++){const c=source[i];if(c==='"'){const from=i++;for(;i<source.length;i++){if(source[i]==='\\'){i++;continue;}if(source[i]==='"')break;}const top=stack.at(-1);if(top?.object&&top.key){const k=JSON.parse(source.slice(from,i+1));if(top.keys.has(k)||['__proto__','constructor','prototype','toJSON'].includes(k))fail(400,'INVALID_BROWSER_REQUEST');top.keys.add(k);top.key=false;}}else if(c==='{'){if(stack.length>32)fail(400,'INVALID_BROWSER_REQUEST');stack.push({object:true,keys:new Set(),key:true});}else if(c==='['){if(stack.length>32)fail(400,'INVALID_BROWSER_REQUEST');stack.push({object:false});}else if(c==='}'||c===']')stack.pop();else if(c===','){const top=stack.at(-1);if(top?.object)top.key=true;}}
 if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'INVALID_BROWSER_REQUEST');return value;
}
async function body(req:HttpRequest){
 if(req.headers['transfer-encoding']||typeof req.headers['content-type']!=='string'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'])||typeof req.headers['content-length']!=='string'||!/^[1-9][0-9]{0,6}$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>128*1024)fail(413,'INVALID_BROWSER_BODY');
 const chunks:Buffer[]=[];let bytes=0;for await(const c of req){const b=Buffer.from(c);bytes+=b.length;if(bytes>128*1024)fail(413,'INVALID_BROWSER_BODY');chunks.push(b);}const all=Buffer.concat(chunks);if(bytes!==Number(req.headers['content-length']))fail(400,'INVALID_BROWSER_BODY');
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(all);return strictJson(text);}catch(e){if(e instanceof B2bSecurityError)throw e;return fail(400,'INVALID_BROWSER_BODY');}
}
/** Separate browser-session listener behind Kong mTLS. It never accepts an API Bearer or arbitrary proxy target. */
export function createAdminBffHandler(core:AdminSessionBff|null,peers:readonly string[]){
 if(!Array.isArray(peers)||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_ADMIN_BFF_EDGE_PEERS_REQUIRED');
 return async(req:HttpRequest,res:HttpResponse):Promise<boolean>=>{
  if(!req.url?.startsWith(BASE))return false;
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Pragma','no-cache');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('Vary','Cookie');
  let callback=false;
  const json=(status:number,v:unknown)=>{const bytes=Buffer.from(JSON.stringify(v));if(bytes.length>16*1024*1024)fail(503,'ADMIN_BFF_UNAVAILABLE');res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Length',String(bytes.length));res.end(bytes);};
  try{
   b2bPrivatePeer(req as any,peers);if(!core)fail(503,'ADMIN_BFF_DISABLED');
   const names=req.rawHeaders.filter((_v,i)=>i%2===0).map(n=>n.toLowerCase());if(new Set(names).size!==names.length||req.url.length>8192||req.headers.authorization!==undefined||typeof req.headers.host!=='string'||req.headers.host.toLowerCase()!==new URL(core.origin).host.toLowerCase()||req.url.includes('\\')||req.url.split('?')[0].includes('%'))fail(400,'INVALID_BROWSER_REQUEST');
   const u=new URL(req.url,core.origin),keys=[...u.searchParams.keys()];if(u.origin!==core.origin||u.hash||new Set(keys).size!==keys.length)fail(400,'INVALID_BROWSER_REQUEST');
   callback=u.pathname===BASE+'/callback';
   if(!callback&&(req.headers.origin!==undefined&&req.headers.origin!==core.origin||req.headers['sec-fetch-site']!==undefined&&req.headers['sec-fetch-site']!=='same-origin'))fail(403,'BROWSER_ORIGIN_REQUIRED');
   if(req.method!=='GET'&&req.headers.origin!==core.origin)fail(403,'BROWSER_ORIGIN_REQUIRED');
   if(req.method==='GET'&&(req.headers['transfer-encoding']||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'))fail(400,'INVALID_BROWSER_BODY');
   await core.rate(req.socket.remoteAddress??'private-edge',u.pathname===BASE+'/session/start'?'start':'request');
   if(callback){
    if(req.method!=='GET'||keys.sort().join(',')!=='code,state')fail(400,'INVALID_SSO_CALLBACK');
    const result=await core.callback(u.searchParams.get('code')!,u.searchParams.get('state')!,cookie(req,FLOW)??'',cookie(req,COOKIE));
    res.setHeader('Set-Cookie',[setCookie(FLOW,'',0),setCookie(COOKIE,result.sessionCookie,Math.ceil((result.expiresAt-Date.now())/1000))]);res.statusCode=303;res.setHeader('Location',core.origin+'/integrations');res.end();return true;
   }
   if(u.pathname===BASE+'/session'&&req.method==='GET'){if(keys.length)fail(400,'INVALID_BROWSER_REQUEST');json(200,await core.summary(cookie(req,COOKIE)));return true;}
   if(u.pathname===BASE+'/session/start'&&req.method==='POST'){
    if(keys.length||Object.keys(await body(req)).length)fail(400,'INVALID_BROWSER_REQUEST');const result=await core.start();res.setHeader('Set-Cookie',setCookie(FLOW,result.browserCookie,120));json(200,{authorizeUrl:result.authorizeUrl});return true;
   }
   if(u.pathname===BASE+'/session/logout'&&req.method==='POST'){
    if(keys.length||Object.keys(await body(req)).length)fail(400,'INVALID_BROWSER_REQUEST');
    const workspace=req.headers['x-factuez-logout']==='workspace';
    if(workspace&&req.headers['sec-fetch-site']!=='same-origin')fail(403,'BROWSER_ORIGIN_REQUIRED');
    const csrf=req.headers['x-factuez-csrf'];if(!workspace&&typeof csrf!=='string')fail(403,'CSRF_REQUIRED');
    const result=workspace?await core.revokeFromWorkspace(cookie(req,COOKIE)):await core.logout(cookie(req,COOKIE)??'',csrf as string);
    res.setHeader('Set-Cookie',[setCookie(COOKIE,'',0),setCookie(FLOW,'',0)]);json(200,result);return true;
   }
   if(!/^\/bff\/b2b-admin\/applications(?:\/[a-f0-9-]{36}(?:\/rotate-secret)?)?$/.test(u.pathname)||!['GET','POST','PATCH'].includes(req.method??''))fail(404,'RESOURCE_NOT_FOUND');
   const csrf=req.headers['x-factuez-csrf'];if(typeof csrf!=='string')fail(403,'CSRF_REQUIRED');
   const result=await core.operation(cookie(req,COOKIE)??'',csrf,req.method!,req.url,req.method==='GET'?undefined:await body(req));
   json(req.method==='POST'&&!u.pathname.endsWith('/rotate-secret')?201:200,result);return true;
  }catch(e){
   if(res.headersSent){res.destroy();return true;}
   if(callback&&core){res.setHeader('Set-Cookie',setCookie(FLOW,'',0));res.statusCode=303;res.setHeader('Location',core.origin+'/integrations?adminSso=failed');res.end();return true;}
   const status=e instanceof B2bSecurityError&&[400,401,403,404,409,413,429,503].includes(e.status)?e.status:503;
   const code=e instanceof B2bSecurityError&&safeCodes.has(e.code)?e.code:status===503?'ADMIN_BFF_UNAVAILABLE':'ADMIN_REQUEST_DENIED';if(status===429)res.setHeader('Retry-After','60');if(status===401)res.setHeader('Set-Cookie',setCookie(COOKIE,'',0));json(status,{code});return true;
  }
 };
}
/** Explicit new listener. Existing APIs keep their existing TLS and authorization policies. */
export function createAdminBffServer(core:AdminSessionBff|null,peers:readonly string[],tls:{ca:Buffer;cert:Buffer;key:Buffer}){
 const handler=createAdminBffHandler(core,peers);let active=0;
 return createServer({...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:8192,headersTimeout:10000,requestTimeout:10000},async(req,res)=>{
  if(active>=16){res.writeHead(429,{'Cache-Control':'private, no-store','Retry-After':'60'});res.end();return;}active++;let released=false;const release=()=>{if(!released){released=true;active--;}};res.once('close',release);res.once('finish',release);
  try{if(!await handler(req,res)){res.writeHead(404,{'Cache-Control':'private, no-store'});res.end();}}catch{res.destroy();}
 });
}
