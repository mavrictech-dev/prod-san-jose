import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {createServer} from 'node:https';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {productionFiscalRouter,productionFiscalScopes,ProductionFiscalClient} from '@factuez/service-access/dist/b2b-production-fiscal';
import {ProductionPrivateTransport} from '@factuez/service-access/dist/b2b-production-transport';
import {hash,type ProductionActor} from '@factuez/service-access/dist/b2b-production-contract';
import {ProductionMemoryStore} from './b2b-production-fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
describe('private billing-to-fiscal SERVICE port',()=>{
 let server:ReturnType<typeof createServer>,client:ProductionFiscalClient;const token=randomBytes(32).toString('base64url'),clientId=randomUUID(),binding={ruc:'20123456789',branchId:randomUUID(),pointId:randomUUID(),series:'F001'},calls:string[]=[];
 const actor:ProductionActor={environment:'PRODUCTION',kind:'SERVICE',clientId,revision:1,tokenHash:hash(token),expiresAt:Date.now()+300000,grants:[...new Set(Object.values(productionFiscalScopes))].map(scope=>({scope,binding}))};
 beforeAll(async()=>{const pki=b2bCertificates(),key=randomBytes(32),identity={introspect:async(t:string)=>{expect(t).toBe(token);return actor;}},providers=Object.fromEntries(Object.keys(productionFiscalScopes).map(operation=>[operation,{authorize:async(a:ProductionActor,b:unknown,body:any)=>{expect(a.kind).toBe('SERVICE');expect(a).not.toHaveProperty('sub');expect(b).toEqual(binding);if(body.issuerRuc!==binding.ruc)throw Error('NATIVE_FISCAL_BINDING_DENIED');},execute:async()=>{calls.push(operation);return {authorized:true,source:'SYNTHETIC_NATIVE_POLICY'};}}]));server=createServer({ca:pki.ca,cert:pki.server,key:pki.key,requestCert:true,rejectUnauthorized:true},productionFiscalRouter('B2B_PRODUCTION',providers,[fingerprint(pki.edge)],new Map([['fiscal-test',key]]),identity,new ProductionMemoryStore()));server.listen(0,'127.0.0.1');await once(server,'listening');client=new ProductionFiscalClient(new ProductionPrivateTransport('https://127.0.0.1:'+(server.address() as any).port,{ca:pki.ca,cert:pki.edge,key:pki.key}),identity,'fiscal-test',key);});
 afterAll(async()=>{server?.closeAllConnections();await new Promise<void>(r=>server?.close(()=>r()));});
 it('attests every fiscal hop without calling human auth/me or official SUNAT',async()=>{for(const operation of Object.keys(productionFiscalScopes) as Array<keyof typeof productionFiscalScopes>){expect(await client.execute(operation,{issuerRuc:binding.ruc},{authorization:'Bearer '+token,operationId:randomUUID(),binding,clientId,revision:1})).toMatchObject({authorized:true,source:'SYNTHETIC_NATIVE_POLICY'});}expect(calls).toHaveLength(8);});
 it('rejects stale client revision before any fiscal request',async()=>{const count=calls.length;await expect(client.execute('admission01',{}, {authorization:'Bearer '+token,operationId:randomUUID(),binding,clientId,revision:2})).rejects.toMatchObject({code:'STALE_FISCAL_ACTOR'});expect(calls).toHaveLength(count);});
});
