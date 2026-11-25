import {it,expect,vi} from 'vitest';
import {createServer} from 'node:https';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {NativeB2bRpc,nativeB2bPrivatePeer} from '../packages/service-access/src/native-b2b-rpc';
it('uses actual mTLS certificates and pinned owners, rejects forged headers, and preserves field errors',async()=>{
 const pki=b2bCertificates(),dir=mkdtempSync(join(tmpdir(),'factuez-b2b-tls-synthetic-')),file=join(dir,'config.json');
 const pin=fingerprint(pki.server),clientPin=fingerprint(pki.edge),token='a'.repeat(43);
 let requests=0;
 const server=createServer({ca:pki.ca,cert:pki.server,key:pki.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  try{nativeB2bPrivatePeer(req as never,'billing');requests++;let body='';for await(const chunk of req)body+=chunk;
   expect(body).toBe('{}');expect(req.headers.authorization).toBe('Bearer '+token);
   res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:'FIELD_VALIDATION_FAILED',message:'Revise el ítem.',fieldErrors:{'lines[0].unitCode':'Seleccione una unidad activa.'}}));
  }catch{res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({code:'PRIVATE_PEER_REQUIRED'}));}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='https://127.0.0.1:'+(server.address() as any).port;
 writeFileSync(file,JSON.stringify({version:'factuez.native-gre.host.v1',listener:{port:3441,host:'127.0.0.1'},peers:[clientPin],b2b:{peers:[clientPin],billing:{origin,serverFingerprint:clientPin}}}));
 vi.stubEnv('NATIVE_B2B_ENABLED','true');vi.stubEnv('NATIVE_GRE_CONFIG_FILE',file);
 const channel=new NativeB2bRpc({identity:{origin,serverFingerprint:pin}},{ca:pki.ca,cert:pki.edge,key:Buffer.from(pki.key)});
 const wrongPin=new NativeB2bRpc({identity:{origin,serverFingerprint:'0'.repeat(64)}},{ca:pki.ca,cert:pki.edge,key:Buffer.from(pki.key)});
 const wrongPeer=new NativeB2bRpc({identity:{origin,serverFingerprint:pin}},{ca:pki.ca,cert:pki.other,key:Buffer.from(pki.key)});
 try{
  expect(()=>nativeB2bPrivatePeer({socket:{encrypted:false,authorized:false},headers:{'x-forwarded-client-cert':clientPin}} as never)).toThrow();
  await expect(channel.post('identity','/internal/native-b2b/identity/introspect',{},'Bearer '+token)).rejects.toMatchObject({status:400,response:{fieldErrors:{'lines[0].unitCode':'Seleccione una unidad activa.'}}});
  expect(requests).toBe(1);
  await expect(wrongPin.post('identity','/internal/native-b2b/identity/introspect',{})).rejects.toMatchObject({status:503});expect(requests).toBe(1);
  await expect(wrongPeer.post('identity','/internal/native-b2b/identity/introspect',{})).rejects.toMatchObject({status:403});expect(requests).toBe(1);
  await expect(channel.post('identity','https://sunat.invalid/anything',{})).rejects.toMatchObject({status:503});
 }finally{channel.close();wrongPin.close();wrongPeer.close();vi.unstubAllEnvs();await new Promise<void>(r=>server.close(()=>r()));unlinkSync(file);rmdirSync(dir);}
},30000);
