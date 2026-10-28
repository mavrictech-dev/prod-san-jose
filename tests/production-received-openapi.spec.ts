import {afterEach,it,expect,vi} from 'vitest';
import {productionReceivedOpenApiPaths} from '../services/received-documents-service/src/automation/production-received-openapi';
import {productionReceivedApiHealth,productionReceivedHealthCapabilities,productionReceivedWorkerHealth} from '../services/received-documents-service/src/automation/production-received-health';
afterEach(()=>vi.unstubAllEnvs());
it('exports exactly the three native routes with companyId in query and human administrative security',()=>{
  const paths=productionReceivedOpenApiPaths();expect(Object.keys(paths)).toHaveLength(3);
  for(const [path,methods]of Object.entries(paths))for(const [method,operation]of Object.entries(methods)){
    expect(path).toMatch(/^\/api\/v1\/received-documents\/automation\/(readiness|validate|activate)$/);
    expect(operation.security).toEqual([{HumanSessionBearer:[]}]);expect(operation.parameters).toEqual([expect.objectContaining({name:'companyId',in:'query',required:true})]);
    expect(operation.responses).toHaveProperty(method==='get'?'200':'201');
    expect(operation.responses).toHaveProperty('403');expect(operation.responses).toHaveProperty('409');
    if(method==='get')expect(operation).not.toHaveProperty('requestBody');
  }
});
it('declares exact revision/RUC bodies, explicit confirmation, expiry and sanitized failed validation',()=>{
  const paths:any=productionReceivedOpenApiPaths(),base='/api/v1/received-documents/automation';
  const schema=(suffix:string)=>paths[base+suffix].post.requestBody.content['application/json'].schema;
  expect(schema('/validate').required).toEqual(['expectedRevision','recipientRuc']);
  expect(schema('/activate').required).toEqual(['expectedRevision','recipientRuc','validationId','confirmation','reviewVersion']);
  expect(schema('/activate').additionalProperties).toBe(false);expect(schema('/activate').properties.reviewVersion.const).toBe('RECEIVED_READ_ONLY_V1');
  const ruc=schema('/validate').properties.recipientRuc;expect(new RegExp(ruc.pattern).test('00000000101')).toBe(true);expect(new RegExp(ruc.pattern).test('other')).toBe(false);
  const result=paths[base+'/validate'].post.responses[201].content['application/json'].schema;expect(result.required).toContain('expiresAt');expect(result.properties.mail.enum).toContain('CONNECTION_REJECTED');
  const serialized=JSON.stringify(paths);for(const field of ['encryptedCredentials','mailPassword','solPassword','access_token','clientSecret'])expect(serialized).not.toContain(field);
});
it('reports server capability dynamically without claiming connector validation or enabling RUCs',()=>{
  expect(productionReceivedHealthCapabilities({})).toMatchObject({mode:'EXTERNAL_READ_DISABLED',liveReadAllowed:false,perRucActivationRequired:true});
  expect(productionReceivedHealthCapabilities({RECEIVED_LIVE_READ_ALLOWED:'true'})).toMatchObject({mode:'LIVE_READ_ONLY_CAPABLE',liveReadAllowed:true,externalConnectionValidation:'NOT_PERFORMED_BY_HEALTH',officialTransmission:false});
  expect(productionReceivedHealthCapabilities({RECEIVED_LOCAL_FIXTURE_ENABLED:'true'}).mode).toBe('LOCAL_FIXTURE_CAPABLE');
});
it('worker health follows actual scheduler tick age even when external capability is enabled',()=>{
  vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED','true');
  expect(productionReceivedWorkerHealth(0,100000)).toMatchObject({status:'unavailable',schedulerHealthy:false,liveReadAllowed:true});
  expect(productionReceivedWorkerHealth(10000,100001).status).toBe('unavailable');
  expect(productionReceivedWorkerHealth(99999,100000)).toMatchObject({status:'ok',schedulerHealthy:true});
});
it('API health checks SQL availability and propagates a database failure',async()=>{
  const query=vi.fn(async()=>[]);vi.stubEnv('RECEIVED_LIVE_READ_ALLOWED','true');
  expect(await productionReceivedApiHealth({$queryRaw:query})).toMatchObject({status:'ok',mode:'LIVE_READ_ONLY_CAPABLE'});
  expect((query.mock.calls as any)[0][0].join('')).toBe('SELECT 1');
  await expect(productionReceivedApiHealth({$queryRaw:async()=>{throw Error('SYNTHETIC_DB_DOWN');}})).rejects.toThrow('SYNTHETIC_DB_DOWN');
});
