import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError, B2bEnabledIdentityScopes } from '../packages/contracts/src/b2b-security';
import { PostgresBusinessStore, type BusinessShift, type BusinessTransaction } from '../services/billing-service/src/b2b/phase8-business';
import { amount, customerBody, productBody, query } from '../services/billing-service/src/b2b/phase8-business/validation';
import { businessCases } from './b2b-phase8-business-integration/cases';
import { customer, empty, harness, MemoryBusinessStore, product } from './helpers/b2b-phase8-business.fixture';
describe('phase8 memory owner engine',()=>{
 businessCases(async()=>new MemoryBusinessStore());
 it('audit failure rolls back rows and idempotency; retry commits once',async()=>{
  const store=new MemoryBusinessStore(),h=harness(store),input={idempotencyKey:randomUUID(),body:customer()};store.failAudit=true;
  await expect(h.createCustomer(input)).rejects.toMatchObject({code:'BUSINESS_STORE_UNAVAILABLE',status:503});expect(store.state).toEqual(empty());store.failAudit=false;expect((await h.createCustomer(input)).replayed).toBe(false);expect(store.state.operations).toHaveLength(1);expect(JSON.stringify(store.state.operations)).not.toContain('synthetic-token');
 });
 it('movement failure rolls back close and audit',async()=>{
  const store=new MemoryBusinessStore(),h=harness(store),s=(await h.open()).data as BusinessShift,before=structuredClone(store.state);store.failMovement=true;
  await expect(h.execute('SHIFTS_CLOSE',{id:s.id,expectedRevision:1,idempotencyKey:randomUUID(),countedAmount:'0.10',reason:'CIERRE'})).rejects.toMatchObject({status:503});expect(store.state).toEqual(before);
 });
 it('records service policy without a human or bearer',async()=>{
  const store=new MemoryBusinessStore(),h=harness(store);h.principal={...h.principal,kind:'SERVICE',subjectId:null,userAuthRevision:null};await h.createCustomer();expect(store.state.operations[0]).toMatchObject({actor:{kind:'SERVICE',subjectId:null,userAuthRevision:null},servicePolicyId:'synthetic-explicit-owner-policy-v1'});expect(JSON.stringify(store.state.operations)).not.toContain('synthetic-token');
 });
 it('closes explicitly',async()=>{const store=new MemoryBusinessStore(),h=harness(store);await h.engine.close();await expect(h.execute('CUSTOMERS_LIST')).rejects.toMatchObject({status:503});});
});
describe('phase8 independent validation and PostgreSQL lifecycle',()=>{
 it('uses the actual authorized vocabulary',()=>{for(const s of ['b2b:customers:read','b2b:products:write','b2b:cash:write'])expect(new Set<string>(B2bEnabledIdentityScopes).has(s)).toBe(true);});
 it('preserves six decimals and rejects rounding controls and malformed identities',()=>{
  expect(amount('0.100001',6)).toBe('0.100001');expect(()=>amount('1.0000001',6)).toThrow();expect(()=>customerBody({...customer(),identityNumber:'1'})).toThrow();expect(()=>customerBody({...customer(),legalName:'x\ny'})).toThrow();expect(()=>productBody({...product(),sku:'x\ny'})).toThrow();expect(()=>query({limit:101})).toThrow();
 });
 it('rolls back releases rejects escaped transactions and closes owned pools exactly once',async()=>{
  const sql:string[]=[],connection={query:vi.fn(async(s:string)=>{sql.push(s);return {rows:[],rowCount:0};}),release:vi.fn()},pool={connect:vi.fn(async()=>connection),end:vi.fn()};
  const store=new PostgresBusinessStore(pool,true);let escaped:BusinessTransaction|undefined;
  await expect(store.transaction(['z','a','a'],async tx=>{escaped=tx;throw new B2bSecurityError(403,'DENIED');})).rejects.toMatchObject({code:'DENIED',status:403});
  expect(sql.at(-1)).toBe('ROLLBACK');expect(connection.release).toHaveBeenCalledOnce();await expect(escaped!.product(randomUUID())).rejects.toMatchObject({status:503});
  await store.close();await store.close();expect(pool.end).toHaveBeenCalledOnce();await expect(store.transaction([],async()=>1)).rejects.toMatchObject({status:503});
 });
 it('does not leak PG errors or destroy a borrowed pool',async()=>{
  const pool={connect:vi.fn(async()=>{throw Object.assign(new Error('secret PostgreSQL details'),{code:'08006'});}),end:vi.fn()};const store=new PostgresBusinessStore(pool);
  await expect(store.transaction([],async()=>1)).rejects.toMatchObject({code:'BUSINESS_STORE_UNAVAILABLE',status:503});await store.close();expect(pool.end).not.toHaveBeenCalled();
 });
});

describe('phase8 owner dependency failure boundaries',()=>{
 it('redacts owner authorization outages before any transaction',async()=>{
  const store=new MemoryBusinessStore(),h=harness(store);
  vi.mocked(h.permissions.authorizeCurrent).mockRejectedValue(new Error('private owner database detail'));
  await expect(h.createCustomer()).rejects.toMatchObject({status:503,code:'OWNER_PERMISSION_UNAVAILABLE',message:'OWNER_PERMISSION_UNAVAILABLE'});
  expect(store.state).toEqual(empty());
 });
 it('redacts current context outages before any transaction',async()=>{
  const store=new MemoryBusinessStore(),h=harness(store);h.context.resolve.mockRejectedValue(new Error('private context connection detail'));
  await expect(h.createProduct()).rejects.toMatchObject({status:503,code:'BUSINESS_CONTEXT_UNAVAILABLE',message:'BUSINESS_CONTEXT_UNAVAILABLE'});
  expect(store.state).toEqual(empty());
 });
});

