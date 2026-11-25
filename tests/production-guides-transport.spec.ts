import { beforeAll,describe,expect,it,vi } from 'vitest';
import { createServer,type Server } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { inspect } from 'node:util';
import { ProductionGuidesRest,ProductionGuidesHttps } from '../services/sunat-service/src/production-guides-transport';
import { ProductionGuidesPrivateHttp,productionGuidesPrivatePeer } from '../packages/sunat-core/src/production-guides-private';
import { productionGuidesBytesHash as hash,PRODUCTION_GUIDES_XSD_SHA256 } from '../packages/sunat-core/src/production-guides';
import { snapshot09,snapshot31,tlsFixture,uuid } from './production-guides.fixture';
import type { ProductionGuidesGrant as Grant } from '../packages/contracts/src/production-guides';
function grant():Grant{return {...snapshot09().scope,actorId:uuid(3),version:1,enabled:true,profiles:['GRE09_PRIVATE04_V1'],credentialRevision:1,certificateFingerprint:'a'.repeat(64),rulesSha256:'b'.repeat(64),xsdSha256:PRODUCTION_GUIDES_XSD_SHA256,expiresAt:'2099-01-01T00:00:00.000Z'};}
let tls:ReturnType<typeof tlsFixture>;beforeAll(()=>{tls=tlsFixture();});
async function listen(server:Server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `https://127.0.0.1:${(server.address() as any).port}`;}
async function close(server:Server){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
describe('GRE local HTTPS contract; official hosts never invoked',()=>{
 it.each(['Bearer','JWT'])('handles 09/31 ZIP and 98/0/99 over synthetic HTTPS, token type %s',async tokenType=>{
  const zip=Buffer.from('SYNTHETIC ZIP FOR TRANSPORT'),cdr=Buffer.from('SYNTHETIC CDR ZIP FOR TRANSPORT'),posts:any[]=[];
  let response:unknown={codRespuesta:'98'};
  const server=createServer({key:tls.key,cert:tls.cert},async(req,res)=>{
   const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));
   res.setHeader('Content-Type','application/json');
   if(req.url?.includes('oauth2'))return res.end(JSON.stringify({access_token:'SYNTHETIC_TOKEN',token_type:tokenType,expires_in:3600}));
   expect(req.headers.authorization).toBe('Bearer SYNTHETIC_TOKEN');
   if(req.method==='POST'){posts.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});return res.end(JSON.stringify({numTicket:uuid(91)}));}
   res.end(JSON.stringify(response));
  });
  const origin=await listen(server),rest=new ProductionGuidesRest({http:new ProductionGuidesHttps({origin,ca:tls.ca}),syntheticOrigin:origin,authorize:async()=>{},credentials:{withGre:async(_g,work)=>work({clientId:'SYNTHETIC',clientSecret:'SYNTHETIC_GRE'},{username:'SECONDARY',password:'SYNTHETIC_SOL'})}});
  try{
   for(const snapshot of [snapshot09(),snapshot31().s]){
    const g={...grant(),issuerRuc:snapshot.issuer.ruc},fileName=`${snapshot.issuer.ruc}-${snapshot.documentType}-${snapshot.series}-${snapshot.number}.zip`;
    expect(await rest.submit(g,{fileName,xmlSha256:'c'.repeat(64),zipSha256:hash(zip),zip})).toEqual({ticket:uuid(91)});
    expect(posts.at(-1)).toEqual({path:'/v1/contribuyente/gem/comprobantes/'+fileName.slice(0,-4),body:{archivo:{nomArchivo:fileName,arcGreZip:zip.toString('base64'),hashZip:hash(zip)}}});
    response={codRespuesta:'98'};expect(await rest.ticket(g,uuid(91))).toEqual({state:'PENDING'});
    for(const codRespuesta of ['0','99']){response={codRespuesta,indCdrGenerado:'1',arcCdr:cdr.toString('base64'),qrUrl:'https://evil.test'};expect(await rest.ticket(g,uuid(91))).toEqual({state:'CDR',cdrZip:cdr});}
    response={codRespuesta:'99',indCdrGenerado:'0',error:{numError:'1345',desError:'El RUC no es valido'},exc:'PRIVATE STACK'};expect(await rest.ticket(g,uuid(91))).toEqual({state:'FAILED_NO_CDR',functionalError:{code:'1345',message:'El RUC no es valido'}});
    response={codRespuesta:'99',indCdrGenerado:'0',error:{numError:1345,desError:'password: SYNTHETIC_SECRET'},exc:'PRIVATE STACK'};expect(await rest.ticket(g,uuid(91))).toEqual({state:'FAILED_NO_CDR'});
   }
   expect(posts).toHaveLength(2);
  }finally{rest.clear();await close(server);}
 });
 it('scopes OAuth token, uses separate credentials, sends immutable ZIP and queries ticket without retry',async()=>{
  const calls:any[]=[];const server=createServer({key:tls.key,cert:tls.cert},async(req,res)=>{const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=Buffer.concat(chunks).toString();calls.push({path:req.url,method:req.method,auth:req.headers.authorization,body});res.setHeader('Content-Type','application/json');res.end(req.url?.includes('oauth2')?JSON.stringify({access_token:'SYNTHETIC_TOKEN',token_type:'Bearer',expires_in:3600}):req.method==='GET'?JSON.stringify({codRespuesta:'98'}):JSON.stringify({numTicket:uuid(91)}));});
  const origin=await listen(server),authorize=vi.fn(async()=>{}),credentials={withGre:async(g:Grant,work:any)=>work({clientId:'synthetic-client',clientSecret:'SYNTHETIC_GRE_SECRET'},{username:'SYNTHETIC',password:'SYNTHETIC_SOL_PASSWORD'})};
  const rest=new ProductionGuidesRest({http:new ProductionGuidesHttps({origin,ca:tls.ca}),credentials,authorize,syntheticOrigin:origin});const g=grant(),zip=Buffer.from('SYNTHETIC ZIP BYTES');
  try{expect(await rest.submit(g,{fileName:g.issuerRuc+'-09-T991-1.zip',xmlSha256:'c'.repeat(64),zipSha256:hash(zip),zip})).toEqual({ticket:uuid(91)});expect(await rest.ticket(g,uuid(91))).toEqual({state:'PENDING'});expect(calls).toHaveLength(3);const oauth=new URLSearchParams(calls[0].body);expect(oauth.get('scope')).toBe('https://api-cpe.sunat.gob.pe');expect(oauth.get('client_secret')).toBe('SYNTHETIC_GRE_SECRET');expect(oauth.get('password')).toBe('SYNTHETIC_SOL_PASSWORD');expect(JSON.parse(calls[1].body)).toEqual({archivo:{nomArchivo:g.issuerRuc+'-09-T991-1.zip',arcGreZip:zip.toString('base64'),hashZip:hash(zip)}});expect(calls[2].method).toBe('GET');expect(rest.source).toBe('LOCAL_SYNTHETIC');expect(inspect(rest)).not.toContain('SYNTHETIC_TOKEN');expect(JSON.stringify(rest)).not.toContain('SECRET');expect(authorize.mock.calls.length).toBe(4);}finally{rest.clear();await close(server);}
 });
 it('fails closed on unauthorized action before network or credentials',async()=>{const http={request:vi.fn()},credentials={withGre:vi.fn()},rest=new ProductionGuidesRest({http,credentials,authorize:async()=>{throw Error('DENIED');}});await expect(rest.ticket(grant(),uuid(91))).rejects.toThrow('DENIED');expect(http.request).not.toHaveBeenCalled();expect(credentials.withGre).not.toHaveBeenCalled();});
 it('checks current submission authorization again after OAuth and never replays POST',async()=>{
  const http={request:vi.fn(async()=>({status:200,body:Buffer.from(JSON.stringify({access_token:'SYNTHETIC_TOKEN',token_type:'JWT',expires_in:3600}))}))};
  const rest=new ProductionGuidesRest({http,credentials:{withGre:async(_g,work)=>work({clientId:'SYNTHETIC',clientSecret:'SYNTHETIC_GRE'},{username:'SECONDARY',password:'SYNTHETIC_SOL'})},authorize:async action=>{if(action==='SUBMIT_GRE')throw Error('CURRENT_GRANT_REVOKED');}});
  const g=grant(),zip=Buffer.from('SYNTHETIC ZIP');
  await expect(rest.submit(g,{fileName:g.issuerRuc+'-09-T991-1.zip',xmlSha256:'a'.repeat(64),zipSha256:hash(zip),zip})).rejects.toThrow('CURRENT_GRANT_REVOKED');
  expect(http.request).toHaveBeenCalledTimes(1);
 });
 it('requires verified TLS and rejects HTTP, redirects and invalid ticket results',async()=>{
  expect(()=>new ProductionGuidesHttps({origin:'http://127.0.0.1',ca:tls.ca})).toThrow();const originServer=createServer({key:tls.key,cert:tls.cert},(_q,res)=>{res.statusCode=302;res.setHeader('Location','https://api-cpe.sunat.gob.pe');res.end('{}');});const origin=await listen(originServer);
  try{await expect(new ProductionGuidesHttps().request({url:origin,method:'GET',headers:{}})).rejects.toThrow();const response=await new ProductionGuidesHttps({origin,ca:tls.ca}).request({url:origin,method:'GET',headers:{}});expect(response.status).toBe(302);await expect(new ProductionGuidesHttps({origin,ca:Buffer.from('INVALID CA')}).request({url:origin,method:'GET',headers:{}})).rejects.toThrow();}finally{await close(originServer);}
 });
 it('provides concrete CA/server-pinned mTLS private ports and denies spoofed peers/routes',async()=>{
  const fingerprint=new X509Certificate(tls.cert).fingerprint256.replaceAll(':','').toLowerCase();const server=createServer({key:tls.key,cert:tls.cert,ca:tls.ca,requestCert:true,rejectUnauthorized:true},async(req,res)=>{try{productionGuidesPrivatePeer(req as any,[fingerprint]);for await(const _b of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({native:true}));}catch{res.statusCode=403;res.end('{}');}});const origin=await listen(server),client=new ProductionGuidesPrivateHttp(origin,{...tls,serverFingerprint:fingerprint});
  try{expect(await client.post('/internal/production-guides/billing/current',{})).toEqual({native:true});await expect(client.post('/outside',{})).rejects.toThrow('GRE_PRIVATE_ROUTE_DENIED');const wrong=new ProductionGuidesPrivateHttp(origin,{...tls,serverFingerprint:'a'.repeat(64)});await expect(wrong.post('/internal/production-guides/billing/current',{})).rejects.toThrow();wrong.close();expect(()=>productionGuidesPrivatePeer({socket:{encrypted:true,authorized:false,getPeerCertificate:()=>({fingerprint256:fingerprint})} as any},[fingerprint])).toThrow();}finally{client.close();await close(server);}
 });
});
