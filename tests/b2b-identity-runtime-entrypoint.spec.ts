import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>({create:vi.fn(),b2b:vi.fn(),enable:vi.fn(),listen:vi.fn(),legacyModule:class LegacyAppModule{}}));
vi.mock('../services/identity-service/node_modules/@nestjs/core',()=>({NestFactory:{create:calls.create}}));
vi.mock('../services/identity-service/src/app.module',()=>({AppModule:calls.legacyModule}));
vi.mock('../services/identity-service/src/b2b/main',()=>({bootstrapB2bIdentity:calls.b2b}));
import {bootstrapIdentity} from '../services/identity-service/src/main';
beforeEach(()=>{vi.clearAllMocks();calls.create.mockResolvedValue({enableShutdownHooks:calls.enable,listen:calls.listen});calls.b2b.mockResolvedValue({});});
afterEach(()=>vi.unstubAllEnvs());
describe('Identity process entrypoint selects one exclusive owner',()=>{
 it('keeps the original legacy default and its port/shutdown hooks when B2B is absent',async()=>{
  vi.stubEnv('B2B_IDENTITY_ENABLED',undefined);vi.stubEnv('PORT','3456');await bootstrapIdentity();
  expect(calls.create).toHaveBeenCalledWith(calls.legacyModule);expect(calls.enable).toHaveBeenCalledOnce();expect(calls.listen).toHaveBeenCalledWith(3456,'0.0.0.0');expect(calls.b2b).not.toHaveBeenCalled();
 });
 it('selects the executable standalone B2B host only for literal true, without creating the legacy AppModule',async()=>{
  vi.stubEnv('B2B_IDENTITY_ENABLED','true');await bootstrapIdentity();expect(calls.b2b).toHaveBeenCalledOnce();expect(calls.create).not.toHaveBeenCalled();expect(calls.enable).not.toHaveBeenCalled();
 });
 it('never falls back to legacy after an opted-in B2B startup failure',async()=>{
  vi.stubEnv('B2B_IDENTITY_ENABLED','true');calls.b2b.mockRejectedValueOnce(Error('SYNTHETIC_STARTUP_BLOCKED'));
  await expect(bootstrapIdentity()).rejects.toThrow('SYNTHETIC_STARTUP_BLOCKED');expect(calls.create).not.toHaveBeenCalled();
 });
 it('does not activate B2B for truthy strings other than the explicit flag',async()=>{
  vi.stubEnv('B2B_IDENTITY_ENABLED','TRUE');vi.stubEnv('PORT',undefined);await bootstrapIdentity();expect(calls.b2b).not.toHaveBeenCalled();expect(calls.listen).toHaveBeenCalledWith(3001,'0.0.0.0');
 });
});
