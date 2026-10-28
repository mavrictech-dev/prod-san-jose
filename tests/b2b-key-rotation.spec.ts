import {describe,it,expect,vi} from 'vitest';
import {createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {B2bTokenCodec} from '../services/identity-service/src/b2b/token';
import {pem,others,basic,ctx} from './b2b-identity.fixture';
import {issuedRotation,nextPem,previousPublic} from './b2b-key-rotation.fixture';
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
const decode=(v:string)=>JSON.parse(Buffer.from(v,'base64url').toString());
function changed(token:string,pem:Buffer,header:Record<string,unknown>={},payload:Record<string,unknown>={}){
 const [h,p]=token.split('.'),data=encode({...decode(h),...header})+'.'+encode({...decode(p),...payload});
 return data+'.'+sign('RSA-SHA256',Buffer.from(data),createPrivateKey(pem)).toString('base64url');
}
describe('B2B SERVICE JWT key rotation, explicit local composition only',()=>{
 it('retains the existing single-key default and never trusts an unspecified key',async()=>{
  const f=await issuedRotation(),next=new B2bTokenCodec(nextPem,f.issuer,f.now,others);
  expect(next.jwks().keys).toHaveLength(1);expect(()=>next.verify(f.token)).toThrow('INVALID_TOKEN');expect(f.codec.verify(f.token).client_id).toBe(f.made.client.id);
 });
 it('signs only with the new key and publishes two public keys without private parameters',async()=>{
  const f=await issuedRotation(),codec=f.rotated(),current=f.compose(codec);
  const response=await current.token(basic(f.made.client.id,f.made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx()),token=response.access_token!;
  expect(decode(token.split('.')[0]).kid).toBe(codec.kid);expect(codec.kid).not.toBe(f.codec.kid);expect(codec.verify(f.token).client_id).toBe(f.made.client.id);
  expect(verify('RSA-SHA256',Buffer.from(token.split('.').slice(0,2).join('.')),createPublicKey(nextPem),Buffer.from(token.split('.')[2],'base64url'))).toBe(true);
  const jwks=codec.jwks();expect(jwks.keys.map(k=>k.kid)).toEqual([codec.kid,f.codec.kid]);
  for(const key of jwks.keys)expect(Object.keys(key).sort()).toEqual(['alg','e','kid','kty','n','use']);
  expect(JSON.stringify(jwks)).not.toContain('PRIVATE');
 });
 it('expires the previous key at 300 seconds, never extends the original token lifetime',async()=>{
  const f=await issuedRotation();f.advance(60);const codec=f.rotated();f.advance(239);expect(codec.verify(f.token)).toBeTruthy();
  f.advance(1);expect(()=>codec.verify(f.token)).toThrow('INVALID_TOKEN');expect(codec.jwks().keys).toHaveLength(2);
  f.advance(60);expect(codec.jwks().keys).toHaveLength(1);expect(()=>codec.verify(f.token)).toThrow('INVALID_TOKEN');
 });
 it('rejects tokens issued by a stale old signer after the declared cutover',async()=>{
  const f=await issuedRotation(),codec=f.rotated();f.advance(1);
  const late=f.codec.mint(f.store.clients.get(f.made.client.id)!,['b2b:context:read']);expect(()=>codec.verify(late)).toThrow('INVALID_TOKEN');
  expect(codec.verify(f.token)).toBeTruthy();
 });
 it('revalidates live client revocation even while the previous signature remains valid',async()=>{
  const f=await issuedRotation(),codec=f.rotated(),current=f.compose(codec);
  expect((await current.authenticate(f.token,['b2b:context:read'],ctx())).clientId).toBe(f.made.client.id);
  await current.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());
  expect(codec.verify(f.token)).toBeTruthy();await expect(current.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:401});
 });
 it('credential rotation and removed scopes still invalidate the old client revision',async()=>{
  const f=await issuedRotation(),current=f.compose(f.rotated());
  const rotated=await current.change('human-step-up',f.made.client.id,{expectedRevision:1},ctx(),true);
  await expect(current.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:401});
  await expect(current.token(basic(f.made.client.id,f.made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx())).rejects.toMatchObject({status:401});
  const fresh=await current.token(basic(f.made.client.id,rotated.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx());
  await current.change('human-step-up',f.made.client.id,{expectedRevision:2,scopes:['b2b:catalog:read']},ctx());
  await expect(current.authenticate(fresh.access_token!,['b2b:context:read'],ctx())).rejects.toMatchObject({status:401});
 });
 it('does not bypass Identity storage or audit failures during overlap',async()=>{
  const f=await issuedRotation(),current=f.compose(f.rotated());f.store.down=true;
  await expect(current.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:503});f.store.down=false;f.store.failAudit=true;
  await expect(current.authenticate(f.token,[],ctx())).rejects.toMatchObject({status:503});
 });
 it('strictly matches kid, signature, algorithm, audience and environment; never follows token key URLs',async()=>{
  const f=await issuedRotation(),codec=f.rotated();
  for(const [header,payload] of [
   [{kid:codec.kid},{}],[{kid:'unknown'},{}],[{alg:'HS256'},{}],[{alg:'none'},{}],[{jku:'https://untrusted.invalid/keys'},{}],
   [{jwk:{kty:'RSA'}},{}],[{}, {aud:'other'}],[{}, {environment:'PRODUCTION'}],[{}, {exp:f.now()+301}],
  ])expect(()=>codec.verify(changed(f.token,pem,header,payload))).toThrow('INVALID_TOKEN');
  expect(()=>codec.verify(changed(f.token,nextPem))).toThrow('INVALID_TOKEN');
 });
 it('allows emergency retirement without overlap when composing only the active key',async()=>{
  const f=await issuedRotation(),activeOnly=new B2bTokenCodec(nextPem,f.issuer,f.now,others);
  expect(()=>activeOnly.verify(f.token)).toThrow('INVALID_TOKEN');expect(activeOnly.jwks().keys).toHaveLength(1);
 });
 it('provides detached operator metadata without secret material or changes to client revisions',async()=>{
  const f=await issuedRotation(),codec=f.rotated(),view=codec.rotationStatus();
  expect(view).toEqual({schemaVersion:'factuez.b2b.signing-keys.v1',environment:'BETA',activeKid:codec.kid,previousKid:f.codec.kid,state:'OVERLAP',cutoverAt:f.now(),previousVerifyUntil:f.now()+300,tokenLifetimeSeconds:300});
  view.activeKid='changed';expect(codec.rotationStatus().activeKid).toBe(codec.kid);expect(f.store.clients.get(f.made.client.id)!.revision).toBe(1);
  f.advance(300);expect(codec.rotationStatus().state).toBe('RETIRED');expect(JSON.stringify(codec.rotationStatus())).not.toMatch(/PRIVATE KEY|BEGIN PUBLIC|secret|password|token:/);
 });
 it('requires exactly one previous public SPKI key and rejects private, weak, reused or future-cutover keys',async()=>{
  const f=await issuedRotation(),weak=generateKeyPairSync('rsa',{modulusLength:1024}).publicKey.export({format:'pem',type:'spki'});
  const config={previous:{publicKey:previousPublic,cutoverAt:f.now()}};
  const nextPublic=Buffer.from(createPublicKey(nextPem).export({format:'pem',type:'spki'}));
  for(const r of [{}, {...config,graceSeconds:3600}, {previous:{...config.previous,extra:true}},
   ...[pem,Buffer.from(weak),nextPublic,others.human,Buffer.from('not a key')].map(publicKey=>({previous:{publicKey,cutoverAt:f.now()}})),
   ...[f.now()+1,-1,NaN,Infinity].map(cutoverAt=>({previous:{publicKey:previousPublic,cutoverAt}}))])
   expect(()=>new B2bTokenCodec(nextPem,f.issuer,f.now,others,r as any)).toThrow();
 });
 it('copies public configuration and never executes configuration accessors or proxies',async()=>{
  const f=await issuedRotation(),config={previous:{publicKey:Buffer.from(previousPublic),cutoverAt:f.now()}},codec=new B2bTokenCodec(nextPem,f.issuer,f.now,others,config);
  config.previous.publicKey.fill(0);config.previous.cutoverAt+=3600;expect(codec.verify(f.token)).toBeTruthy();
  let called=0;const accessor=Object.defineProperty({},'previous',{enumerable:true,get(){called++;throw Error('PRIVATE');}});
  const proxy=new Proxy({previous:{publicKey:previousPublic,cutoverAt:f.now()}},{get(){called++;throw Error('PRIVATE');}});
  for(const r of [accessor,proxy])expect(()=>new B2bTokenCodec(nextPem,f.issuer,f.now,others,r as any)).toThrow();expect(called).toBe(0);
 });
 it('fails closed on a backward or invalid clock and never reactivates a retired key locally',async()=>{
  const f=await issuedRotation(),codec=f.rotated();f.advance(300);expect(codec.jwks().keys).toHaveLength(1);f.advance(-1);
  expect(()=>codec.verify(f.token)).toThrow('TOKEN_CLOCK_UNAVAILABLE');expect(()=>codec.jwks()).toThrow('TOKEN_CLOCK_UNAVAILABLE');
  expect(()=>codec.mint(f.store.clients.get(f.made.client.id)!,['b2b:context:read'])).toThrow('TOKEN_CLOCK_UNAVAILABLE');
  f.advance(1);expect(codec.jwks().keys).toHaveLength(1);f.setTime(NaN);expect(()=>codec.jwks()).toThrow('TOKEN_CLOCK_UNAVAILABLE');
 });
 it('caps overlap using elapsed monotonic time even if wall-clock seconds do not move',async()=>{
  const f=await issuedRotation(),start=performance.now(),mock=vi.spyOn(performance,'now').mockReturnValue(start);
  try{const codec=f.rotated();mock.mockReturnValue(start+300001);expect(codec.jwks().keys).toHaveLength(1);
   mock.mockReturnValue(start);expect(codec.jwks().keys).toHaveLength(1);expect(()=>codec.verify(f.token)).toThrow('INVALID_TOKEN');
  }finally{mock.mockRestore();}
 });
});
