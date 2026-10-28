import 'reflect-metadata';
import {beforeAll,describe,it,expect} from 'vitest';
import {request} from 'node:https';
import {createB2bIdentityApplication} from '../services/identity-service/src/b2b/application';
import {B2bTokenCodec} from '../services/identity-service/src/b2b/token';
import {B2bIdentityHttp,B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {issuedRotation,nextPem} from './b2b-key-rotation.fixture';
import {others,basic} from './b2b-identity.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
let tls:ReturnType<typeof b2bCertificates>;
beforeAll(()=>{tls=b2bCertificates();},30000);
async function withIdentity(f:Awaited<ReturnType<typeof issuedRotation>>,codec:B2bTokenCodec,work:(http:ReturnType<typeof client>)=>Promise<void>){
 const app=await createB2bIdentityApplication(f.compose(codec),{token:[fingerprint(tls.edge)],admin:[fingerprint(tls.edge)],resource:[fingerprint(tls.resource)]},{ca:tls.ca,cert:tls.server,key:tls.key});
 try{await app.listen(0,'127.0.0.1');await work(client(app.getHttpServer().address().port));}finally{await app.close();}
}
function client(port:number){
 const rpc=new B2bIdentityHttp(new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:tls.ca,cert:tls.resource,key:tls.key}));
 const send=(path:string,method='GET',body?:unknown,headers:Record<string,string>={},peer:'edge'|'resource'|'other'='resource')=>{
  const data=body===undefined?undefined:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,timeout:4000,
    headers:{...(data?{'Content-Type':'application/json','Content-Length':String(data.length)}:{}),...headers}},response=>{
     const chunks:Buffer[]=[];response.on('data',c=>chunks.push(c));response.on('error',reject);response.on('end',()=>{
      try{resolve({status:response.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),headers:response.headers});}catch(e){reject(e);}
     });
    });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('SYNTHETIC_HTTP_TIMEOUT')));req.end(data);
  });
 };
 return {send,rpc,token:(id:string,secret:string)=>send('/b2b/oauth/token','POST','grant_type=client_credentials&scope=b2b%3Acontext%3Aread',
  {Authorization:basic(id,secret),'Content-Type':'application/x-www-form-urlencoded'},'edge')};
}
describe('key rotation through actual Identity mTLS endpoints and private RPC',()=>{
 it('restarts with the new signer, accepts existing JWT until expiry, then retires its JWK and still issues new tokens',async()=>{
  const f=await issuedRotation();let oldToken='';
  await withIdentity(f,f.codec,async http=>{
   const response=await http.token(f.made.client.id,f.made.clientSecret!);expect(response.status).toBe(200);oldToken=response.body.access_token;
   expect((await http.send('/internal/b2b/jwks')).body.keys).toHaveLength(1);
  });
  const codec=f.rotated();await withIdentity(f,codec,async http=>{
   expect((await http.rpc.authenticate(oldToken,['b2b:context:read'],'SERVICE')).clientId).toBe(f.made.client.id);
   const keys=await http.send('/internal/b2b/jwks');expect(keys.status).toBe(200);expect(keys.body.keys.map((k:any)=>k.kid)).toEqual([codec.kid,f.codec.kid]);
   expect(keys.headers['cache-control']).toBe('private, no-store');for(const k of keys.body.keys)expect(k).not.toHaveProperty('d');
   const minted=await http.token(f.made.client.id,f.made.clientSecret!);expect(minted.status).toBe(200);expect(JSON.parse(Buffer.from(minted.body.access_token.split('.')[0],'base64url').toString()).kid).toBe(codec.kid);
   expect((await http.send('/internal/b2b/jwks','GET',undefined,{},'other')).status).toBe(403);
   f.advance(300);await expect(http.rpc.authenticate(oldToken,[],'SERVICE')).rejects.toMatchObject({status:401});
   expect((await http.send('/internal/b2b/jwks')).body.keys.map((k:any)=>k.kid)).toEqual([codec.kid]);
   const fresh=await http.token(f.made.client.id,f.made.clientSecret!);expect(fresh.status).toBe(200);
   expect((await http.rpc.authenticate(fresh.body.access_token,['b2b:context:read'],'SERVICE')).clientId).toBe(f.made.client.id);
  });
 });
 it('keeps administrative revocation effective during overlap and supports emergency key removal',async()=>{
  const f=await issuedRotation(),codec=f.rotated();await withIdentity(f,codec,async http=>{
   const active=(await http.token(f.made.client.id,f.made.clientSecret!)).body.access_token;
   for(const token of [f.token,active])expect((await http.rpc.authenticate(token,[],'SERVICE')).clientId).toBe(f.made.client.id);
   const response=await http.send('/internal/b2b/clients/'+f.made.client.id,'PATCH',{expectedRevision:1,enabled:false},{Authorization:'Bearer human-step-up'},'edge');expect(response.status).toBe(200);
   for(const token of [f.token,active])await expect(http.rpc.authenticate(token,[],'SERVICE')).rejects.toMatchObject({status:401});
   expect(codec.verify(f.token)).toBeTruthy();
  });
  const emergency=new B2bTokenCodec(nextPem,f.issuer,f.now,others);await withIdentity(f,emergency,async http=>{
   expect((await http.send('/internal/b2b/jwks')).body.keys).toHaveLength(1);await expect(http.rpc.authenticate(f.token,[],'SERVICE')).rejects.toMatchObject({status:401});
  });
 });
});
