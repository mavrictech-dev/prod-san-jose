import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {createServer,type Server} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {inspect} from 'node:util';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {HttpReceptionServiceTokenProvider,type ReceptionServiceTokenConfig} from '../services/received-documents-service/src/b2b/automation-read-only.token';
import type {ReceptionDispatchContext} from '../services/received-documents-service/src/b2b/automation-dispatch';

// Throwaway loopback-only HTTPS/mTLS servers. No deployed Identity, SUNAT,
// environment keys, registered application, or production secret is accessed.
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const secret='FICTITIOUS_OWNER_SECRET_'.padEnd(43,'X');
function context(source:'MAIL'|'SIRE'='MAIL'):ReceptionDispatchContext{
 return {runId:id(1),source,revision:1,scope:{environment:'BETA',companyId:101,recipientRuc:'00000000001',branchId:id(2)},
  actor:{kind:'SERVICE',clientId:id(3),clientRevision:1,subjectId:null,userAuthRevision:null}};
}
type Reply=(res:ServerResponse,form:URLSearchParams)=>void;
describe('HttpReceptionServiceTokenProvider with only fictitious loopback mTLS',()=>{
 let tls:ReturnType<typeof b2bCertificates>,foreignTls:ReturnType<typeof b2bCertificates>,server:Server,wrongHostServer:Server,origin:string,wrongHostOrigin:string;
 let records:{url:string;method:string;form:URLSearchParams;authorization:string;authorized:boolean;version:string|null}[]=[];
 let reply:Reply|undefined;
 const handler=(req:IncomingMessage,res:ServerResponse)=>{
  const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
   const form=new URLSearchParams(Buffer.concat(chunks).toString()),socket=req.socket as import('node:tls').TLSSocket;
   records.push({url:req.url!,method:req.method!,form,authorization:req.headers.authorization??'',authorized:socket.authorized,version:socket.getProtocol()});
   res.setHeader('Content-Type','application/json');
   if(reply){reply(res,form);return;}
   res.end(JSON.stringify({access_token:`FAKE.token.${records.length}`,token_type:'Bearer',expires_in:300,scope:form.get('scope')}));
  });
 };
 beforeAll(async()=>{
  tls=b2bCertificates();foreignTls=b2bCertificates();
  const options={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
  server=createServer(options,handler);wrongHostServer=createServer(options,handler);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  await new Promise<void>(resolve=>wrongHostServer.listen(0,'127.0.0.2',resolve));
  origin=`https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  wrongHostOrigin=`https://127.0.0.2:${(wrongHostServer.address() as AddressInfo).port}`;
 },30000);
 beforeEach(()=>{records=[];reply=undefined;});
 afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
 afterAll(async()=>{for(const instance of [server,wrongHostServer])if(instance){instance.closeAllConnections();await new Promise<void>(resolve=>instance.close(()=>resolve()));}});
 function config(changes:Partial<ReceptionServiceTokenConfig>={}):ReceptionServiceTokenConfig{
  return {origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverFingerprintSha256:fingerprint(tls.server)},
   credentials:vi.fn(async c=>({clientId:c.actor.clientId,revision:c.actor.clientRevision,clientSecret:secret})),enabled:true,...changes};
 }
 it('does no constructor I/O and defaults to disabled without reading owner credentials',async()=>{
  const c=config();delete c.enabled;const provider=new HttpReceptionServiceTokenProvider(c);
  expect(records).toHaveLength(0);expect(c.credentials).not.toHaveBeenCalled();
  await expect(provider.credentials(context())).rejects.toMatchObject({status:403,code:'RECEIVED_SERVICE_TOKEN_DISABLED'});
  expect(records).toHaveLength(0);expect(c.credentials).not.toHaveBeenCalled();
 });
 it.each(['USER','subject','authRevision','clientId','revision','source','environment'])('blocks invalid actor/context %s before credentials/network',async change=>{
  const c=config(),input=context();
  if(change==='USER')input.actor={...input.actor,kind:'USER',subjectId:id(4),userAuthRevision:0};
  if(change==='subject')input.actor.subjectId=id(4);
  if(change==='authRevision')input.actor.userAuthRevision=0;
  if(change==='clientId')input.actor.clientId='not-uuid';
  if(change==='revision')input.actor.clientRevision=0;
  if(change==='source')(input as any).source='ALL';
  if(change==='environment')(input.scope as any).environment='PRODUCTION';
  await expect(new HttpReceptionServiceTokenProvider(c).credentials(input)).rejects.toMatchObject({status:403,code:'RECEIVED_SERVICE_ACTOR_REQUIRED'});
  expect(c.credentials).not.toHaveBeenCalled();expect(records).toHaveLength(0);
 });
 it.each(['other-client','other-revision','invalid-secret','short-secret','long-secret'])('blocks mismatched owner credentials %s before network',async change=>{
  const c=config({credentials:async()=>({clientId:change==='other-client'?id(9):id(3),revision:change==='other-revision'?2:1,
   clientSecret:change==='invalid-secret'?secret+':':change==='short-secret'?'x'.repeat(31):change==='long-secret'?'x'.repeat(257):secret})});
  await expect(new HttpReceptionServiceTokenProvider(c).credentials(context())).rejects.toMatchObject({status:403,code:'RECEIVED_SERVICE_ACTOR_REQUIRED'});expect(records).toHaveLength(0);
 });
 it.each(['MAIL','SIRE'] as const)('uses only fixed OAuth POST, Basic, mTLS and exact %s scopes',async source=>{
  const c=config(),provider=new HttpReceptionServiceTokenProvider(c),access=await provider.credentials(context(source));
  expect(access).toEqual({kind:'SERVICE',token:'FAKE.token.1'});expect(c.credentials).toHaveBeenCalledWith(context(source));
  expect(records).toHaveLength(1);const record=records[0];
  expect(record.url).toBe('/b2b/oauth/token');expect(record.method).toBe('POST');expect([...record.form.keys()].sort()).toEqual(['grant_type','scope']);
  expect(record.form.get('grant_type')).toBe('client_credentials');expect(record.form.get('scope')).toBe(source==='MAIL'?'b2b:received:sync b2b:received:write':'b2b:received:sync');
  expect(record.authorization).toBe(`Basic ${Buffer.from(`${id(3)}:${secret}`).toString('base64')}`);expect(record.authorized).toBe(true);expect(['TLSv1.2','TLSv1.3']).toContain(record.version);
 });
 it.each(['pin','CA','hostname','client-cert'])('rejects wrong %s before HTTP and hides transport details',async failure=>{
  const c=config();
  if(failure==='pin')c.tls.serverFingerprintSha256='0'.repeat(64);
  if(failure==='CA')c.tls.ca=foreignTls.ca;
  if(failure==='hostname')c.origin=wrongHostOrigin;
  if(failure==='client-cert'){c.tls.cert=foreignTls.edge;c.tls.key=foreignTls.key;}
  await expect(new HttpReceptionServiceTokenProvider(c).credentials(context())).rejects.toMatchObject({status:503,code:'RECEIVED_SERVICE_TOKEN_UNAVAILABLE',message:'RECEIVED_SERVICE_TOKEN_UNAVAILABLE'});
  expect(records).toHaveLength(0);
 });
 it.each(['http://127.0.0.1','https://user:pass@example.com','https://example.com/path','https://example.com?x=1','https://example.com/#bad'])('rejects a non-root or unsafe origin %s',value=>{
  expect(()=>new HttpReceptionServiceTokenProvider(config({origin:value}))).toThrow('RECEIVED_SERVICE_TOKEN_UNAVAILABLE');
 });
 it('never follows a redirect to a new token endpoint',async()=>{
  reply=res=>{res.statusCode=302;res.setHeader('Location',origin+'/another-endpoint');res.end('FAKE-PRIVATE-BODY');};
  await expect(new HttpReceptionServiceTokenProvider(config()).credentials(context())).rejects.toMatchObject({status:503});expect(records).toHaveLength(1);
 });
 it.each(['extra','missing','duplicate','wrong-source','double-space'])('rejects %s response scopes',async change=>{
  const scopes=change==='extra'?'b2b:received:sync b2b:received:write b2b:received:configure':change==='missing'?'b2b:received:sync':
   change==='duplicate'?'b2b:received:sync b2b:received:sync':change==='wrong-source'?'b2b:context:read b2b:received:write':'b2b:received:sync  b2b:received:write';
  reply=res=>res.end(JSON.stringify({access_token:'FAKE.token',token_type:'Bearer',expires_in:300,scope:scopes}));
  await expect(new HttpReceptionServiceTokenProvider(config()).credentials(context())).rejects.toMatchObject({status:503,code:'RECEIVED_SERVICE_TOKEN_INVALID_RESPONSE'});
 });
 it('accepts an exact scope set even when Identity returns another order',async()=>{
  reply=res=>res.end(JSON.stringify({access_token:'FAKE.token',token_type:'Bearer',expires_in:300,scope:'b2b:received:write b2b:received:sync'}));
  expect(await new HttpReceptionServiceTokenProvider(config()).credentials(context())).toEqual({kind:'SERVICE',token:'FAKE.token'});
 });
 it.each([0,301,-1,1.5,null,'300'])('rejects invalid expires_in %s',expires_in=>{
  reply=(res,form)=>res.end(JSON.stringify({access_token:'FAKE.token',token_type:'Bearer',expires_in,scope:form.get('scope')}));
  return expect(new HttpReceptionServiceTokenProvider(config()).credentials(context())).rejects.toMatchObject({status:503,code:'RECEIVED_SERVICE_TOKEN_INVALID_RESPONSE'});
 });
 it.each(['NaN','Infinity'])('rejects raw nonfinite expires_in %s',expires=>{
  reply=res=>res.end(`{"access_token":"FAKE.token","token_type":"Bearer","expires_in":${expires},"scope":"b2b:received:sync b2b:received:write"}`);
  return expect(new HttpReceptionServiceTokenProvider(config()).credentials(context())).rejects.toMatchObject({status:503,code:'RECEIVED_SERVICE_TOKEN_INVALID_RESPONSE'});
 });
 it.each(['extra-field','wrong-type','bad-token','bad-json'])('rejects %s token bodies without exposing contents',async change=>{
  reply=(res,form)=>res.end(change==='bad-json'?'FAKE-PRIVATE-TOKEN-CONTENT':JSON.stringify({access_token:change==='bad-token'?'FAKE private token':'FAKE.token',
   token_type:change==='wrong-type'?'bearer':'Bearer',expires_in:300,scope:form.get('scope'),...(change==='extra-field'?{refresh_token:'FAKE-PRIVATE'}:{})}));
  await expect(new HttpReceptionServiceTokenProvider(config()).credentials(context())).rejects.toMatchObject({message:'RECEIVED_SERVICE_TOKEN_INVALID_RESPONSE'});
 });
 it.each(['declared','streamed'])('bounds %s response bodies at 32 KiB',async mode=>{
  reply=res=>{if(mode==='declared')res.setHeader('Content-Length',32769);res.write('x'.repeat(20000));res.end('x'.repeat(12769));};
  await expect(new HttpReceptionServiceTokenProvider(config()).credentials(context())).rejects.toMatchObject({code:'RECEIVED_SERVICE_TOKEN_INVALID_RESPONSE'});
 });
 it('limits the whole request to five seconds even if the server never finishes',async()=>{
  reply=res=>{res.write(' ');};
  const started=Date.now();await expect(new HttpReceptionServiceTokenProvider(config()).credentials(context())).rejects.toMatchObject({status:503,code:'RECEIVED_SERVICE_TOKEN_UNAVAILABLE'});
  expect(Date.now()-started).toBeLessThan(6500);
 },10000);
 it('reuses a stable in-memory token but resolves current owner credentials on every action',async()=>{
  const c=config(),provider=new HttpReceptionServiceTokenProvider(c),first=await provider.credentials(context());
  const nextContext={...context(),runId:id(99)};expect(await provider.credentials(nextContext)).toEqual(first);expect(records).toHaveLength(1);expect(c.credentials).toHaveBeenCalledTimes(2);
 });
 it('coalesces concurrent minting for the same application and selected scopes',async()=>{
  const provider=new HttpReceptionServiceTokenProvider(config());
  const results=await Promise.all(Array.from({length:10},()=>provider.credentials(context())));expect(new Set(results.map(r=>r.token)).size).toBe(1);expect(records).toHaveLength(1);
 });
 it('selects distinct cache entries after secret rotation, revision, application or scopes change',async()=>{
  let currentSecret=secret;
  const c=config({credentials:async c=>({clientId:c.actor.clientId,revision:c.actor.clientRevision,clientSecret:currentSecret})}),provider=new HttpReceptionServiceTokenProvider(c);
  await provider.credentials(context());currentSecret='ROTATED_FAKE_SECRET_'.padEnd(43,'Y');await provider.credentials(context());
  const revised=context();revised.actor.clientRevision=2;await provider.credentials(revised);
  const other=context();other.actor.clientId=id(9);await provider.credentials(other);await provider.credentials(context('SIRE'));
  expect(records).toHaveLength(5);
 });
 it('expires cached tokens five seconds before their advertised lifetime',async()=>{
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
  const provider=new HttpReceptionServiceTokenProvider(config());await provider.credentials(context());
  vi.mocked(Date.now).mockReturnValue(now+294999);await provider.credentials(context());expect(records).toHaveLength(1);
  vi.mocked(Date.now).mockReturnValue(now+295000);await provider.credentials(context());expect(records).toHaveLength(2);
 });
 it.each([1,5])('accepts expires_in %i without caching an already skew-expired token',async expires_in=>{
  reply=(res,form)=>res.end(JSON.stringify({access_token:`FAKE.token.${records.length}`,token_type:'Bearer',expires_in,scope:form.get('scope')}));
  const provider=new HttpReceptionServiceTokenProvider(config());await provider.credentials(context());await provider.credentials(context());expect(records).toHaveLength(2);
 });
 it('evicts old cache entries to keep no more than 100 tokens',async()=>{
  const provider=new HttpReceptionServiceTokenProvider(config());
  for(let n=0;n<101;n++){const c=context();c.actor.clientId=id(n+10);await provider.credentials(c);}
  const recent=context();recent.actor.clientId=id(110);await provider.credentials(recent);expect(records).toHaveLength(101);
  const oldest=context();oldest.actor.clientId=id(10);await provider.credentials(oldest);expect(records).toHaveLength(102);
 },15000);
 it('does not cache failures or disclose credentials, private keys or tokens through serialization/inspection',async()=>{
  const c=config(),provider=new HttpReceptionServiceTokenProvider(c);reply=res=>{res.statusCode=401;res.end('FAKE-PRIVATE-AUTHORIZATION');};
  await expect(provider.credentials(context())).rejects.toMatchObject({status:403,code:'RECEIVED_SERVICE_TOKEN_DENIED'});
  reply=undefined;await provider.credentials(context());expect(records).toHaveLength(2);
  const visible=[JSON.stringify(provider),inspect(provider),inspect(provider,{showHidden:true}),JSON.stringify(Object.getOwnPropertyDescriptors(provider))].join('\n');
  for(const hidden of [secret,tls.key.toString(),'FAKE.token.2',records[0].authorization])expect(visible).not.toContain(hidden);
  expect(Object.keys(provider)).toEqual([]);
 });
});
