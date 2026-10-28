import {describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {HistoryReadIdentityAdapter} from '../services/history-service/src/read-identity';
const require=createRequire(import.meta.url),{jwtFixture}=require('./helpers/history-read-auth.cjs'),f=require('./helpers/history-full-fixtures.cjs');
const jwt=jwtFixture();
function setup(claims=jwt.claims()){
  const fetcher=vi.fn(async()=>new Response(JSON.stringify(claims),{headers:{'content-type':'application/json'}}));
  const options={publicKey:jwt.publicKey,issuer:'factuez-identity',audience:'factuez-services',identityBaseUrl:'http://identity-service:3001',fetcher,now:()=>jwt.now*1000};
  return {adapter:new HistoryReadIdentityAdapter(options),fetcher,options};
}
describe('historial: RS256 y autoridad Identity fresca, sólo lectura',()=>{
  it('firma local válida y sesión vigente producen actor verificado',async()=>{
    const s=setup();expect(await s.adapter.authorize(jwt.token(),'history.view')).toMatchObject({userId:f.actor().userId,permissions:['history.view'],scope:{kind:'GLOBAL'}});
    expect(s.fetcher).toHaveBeenCalledWith('http://identity-service:3001/api/v1/auth/me',expect.objectContaining({redirect:'error',headers:expect.objectContaining({'Cache-Control':'no-store'})}));
  });
  it('alcance firmado usa UUID de serie; no acepta etiquetas ni client scope',async()=>{
    const c=jwt.claims(f.actor(false)),s=setup(c),r=await s.adapter.authorize(jwt.token(c),'history.view');
    expect(r.scope).toMatchObject({kind:'ASSIGNED',seriesCounterIds:f.actor(false).scope.seriesCounterIds});
    c.scope.series=['BQ01'];const bad=setup(c);await expect(bad.adapter.authorize(jwt.token(c),'history.view')).rejects.toMatchObject({status:401});expect(bad.fetcher).not.toHaveBeenCalled();
  });
  it.each(['HS256','none','RS512'])('algoritmo %s nunca consulta Identity',async alg=>{
    const s=setup();await expect(s.adapter.authorize(jwt.token(jwt.claims(),{alg}),'history.view')).rejects.toMatchObject({status:401});expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each(['iss','aud','sub','authVersion','exp','iat','nbf','browserSessionId'])('claim %s inválido bloquea antes de la red',async field=>{
    const c=jwt.claims();Object.assign(c,{[field]:field==='exp'?jwt.now:field==='iat'?jwt.now+100:field==='nbf'?jwt.now+100:field==='authVersion'?-1:'wrong'});
    const s=setup(c);await expect(s.adapter.authorize(jwt.token(c),'history.view')).rejects.toMatchObject({status:401});expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('firma de otra clave o payload alterado no se aceptan',async()=>{
    const s=setup(),other=jwtFixture();await expect(s.adapter.authorize(other.token(),'history.view')).rejects.toMatchObject({status:401});
    const parts=jwt.token().split('.');parts[1]=Buffer.from(JSON.stringify({...jwt.claims(),sub:f.uuid(999)})).toString('base64url');
    await expect(s.adapter.authorize(parts.join('.'),'history.view')).rejects.toMatchObject({status:401});expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each(['','qa-token','a.b.c','a.b.c.d'])('token malformado %s no se acepta',async token=>{
    const s=setup();await expect(s.adapter.authorize(token,'history.view')).rejects.toMatchObject({status:401});expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('document.view faltante se deniega sin I/O',async()=>{
    const c=jwt.claims();c.permissions=['document.issue'];const s=setup(c);
    await expect(s.adapter.authorize(jwt.token(c),'history.view')).rejects.toMatchObject({status:403});expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('adaptador jamás convierte document.view en permiso de importar',async()=>{
    const s=setup();await expect(s.adapter.authorize(jwt.token(),'history.import')).rejects.toMatchObject({status:403,code:'HISTORY_READ_ONLY'});expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each([401,403,500,302])('respuesta Identity %i cierra el acceso',async status=>{
    const s=setup();s.fetcher.mockResolvedValue(new Response('SECRET_RESPONSE',{status}));
    await expect(s.adapter.authorize(jwt.token(),'history.view')).rejects.toMatchObject({status:status<500&&status!==302?401:503});
  });
  it('fallo de conexión no revela detalles ni permite caché de permisos',async()=>{
    const s=setup();s.fetcher.mockRejectedValue(new Error('SECRET_URL'));await expect(s.adapter.authorize(jwt.token(),'history.view')).rejects.toMatchObject({status:503,message:'HISTORY_IDENTITY_UNAVAILABLE'});
  });
  it.each(['changedActor','changedScope','changedVersion','changedBrowser','noPermission'])('cambio fresco %s bloquea la sesión anterior',async change=>{
    const fresh=jwt.claims();if(change==='changedActor')fresh.sub=f.uuid(999);if(change==='changedScope')fresh.scope=jwt.claims(f.actor(false)).scope;
    if(change==='changedVersion')fresh.authVersion++;if(change==='changedBrowser')fresh.browserSessionId='a'.repeat(64);if(change==='noPermission')fresh.permissions=[];
    const s=setup(fresh);await expect(s.adapter.authorize(jwt.token(),'history.view')).rejects.toMatchObject({status:change==='noPermission'?403:401});
  });
  it.each(['wrongContent','invalidJson','tooLarge'])('respuesta %s se limita y bloquea',async which=>{
    const s=setup();s.fetcher.mockResolvedValue(new Response(which==='invalidJson'?'{':which==='tooLarge'?'a'.repeat(65537):'html',{headers:{'content-type':which==='wrongContent'?'text/html':'application/json'}}));
    await expect(s.adapter.authorize(jwt.token(),'history.view')).rejects.toMatchObject({status:503});
  });
  it.each(['https://example.com','http://127.0.0.1:80','http://user:password@identity-service:3001','http://identity-service:3001/extra','http://identity-service:3001/','not-a-url'])('URL %s no sale del perímetro',url=>{
    const s=setup();expect(()=>new HistoryReadIdentityAdapter({...s.options,identityBaseUrl:url})).toThrow(/CONFIG_INVALID/);
  });
  it('conserva configuración al mutar el objeto del caller',async()=>{
    const s=setup();s.options.issuer='changed';expect(await s.adapter.authorize(jwt.token(),'history.view')).toMatchObject({scope:{kind:'GLOBAL'}});
  });
  it('no admite clave privada suministrada ni HMAC como clave pública',()=>{
    const s=setup();expect(()=>new HistoryReadIdentityAdapter({...s.options,publicKey:'-----BEGIN PRIVATE KEY-----'})).toThrow(/PUBLIC_KEY_REQUIRED/);
  });
});
