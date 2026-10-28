import { beforeEach, afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { B2bPhase8Business, type BusinessStore, type BusinessCustomer, type BusinessProduct, type BusinessShift, type BusinessPermissionDecision } from '../../services/billing-service/src/b2b/phase8-business';
import { harness, customer, product, key, error } from '../helpers/b2b-phase8-business.fixture';
export { harness, fixture, businessFixture, MemoryBusinessStore, customer, product, empty } from '../helpers/b2b-phase8-business.fixture';
export function businessCases(make:()=>Promise<BusinessStore>,cleanup?:()=>Promise<void>){
 let h:ReturnType<typeof harness>;beforeEach(async()=>{h=harness(await make());});if(cleanup)afterAll(cleanup);
 it('requires full BETA binding and exact hierarchy',async()=>{
  for(const bad of [{...h.b,environment:'PRODUCTION'},{...h.b,documentType:undefined}])await expect(h.execute('CUSTOMERS_LIST',{binding:bad})).rejects.toMatchObject({status:400});
  for(const change of [{issuerRuc:'00000000003'},{seriesId:randomUUID()},{branchId:h.other.branchId},{pointId:h.other.pointId}])await expect(h.execute('CUSTOMERS_LIST',{binding:{...h.b,...change}})).rejects.toMatchObject(error('RESOURCE_NOT_FOUND',404));
 });
 it('requires actual Identity scopes and actor kind',async()=>{
  h.principal={...h.principal,scopes:['b2b:context:read']};await expect(h.execute('CUSTOMERS_LIST')).rejects.toMatchObject(error('INVALID_PRINCIPAL',401));
  await expect(h.engine.execute({token:'synthetic-token',kind:'SERVICE'},'CUSTOMERS_LIST',{binding:h.b})).rejects.toMatchObject({status:401});
 });
 it('fails closed without owner port and denies USER writes without current owner policy',async()=>{
  const engine=new B2bPhase8Business(h.store,h.identity,h.context);await expect(engine.execute(h.auth(),'PRODUCTS_LIST',{binding:h.b})).rejects.toMatchObject(error('OWNER_PERMISSION_PORT_REQUIRED',503));
  h.allowed=false;await expect(h.createCustomer()).rejects.toMatchObject(error('OWNER_PERMISSION_DENIED',403));await expect(h.createProduct()).rejects.toMatchObject(error('OWNER_PERMISSION_DENIED',403));
 });
 it('never infers global authority from RUC grants and requires live step-up',async()=>{
  h.global=false;await expect(h.createProduct()).rejects.toMatchObject(error('HUMAN_GLOBAL_PRODUCT_AUTHORITY_REQUIRED',403));
  h.global=true;h.stepUp=false;await expect(h.createProduct()).rejects.toMatchObject(error('HUMAN_GLOBAL_PRODUCT_AUTHORITY_REQUIRED',403));
 });
 it('checks product.manage, human subject and auth revision independently',async()=>{
  for(const patch of [{subjectId:randomUUID()},{userAuthRevision:99},{permissions:[]},{scope:'ASSIGNED'},{stepUpVerified:false}]){
   const d:BusinessPermissionDecision={allowed:true,revision:'1',globalProductAuthority:{subjectId:h.principal.subjectId!,userAuthRevision:1,scope:'GLOBAL',stepUpVerified:true,permissions:['product.manage']}};
   Object.assign(d.globalProductAuthority!,patch);vi.mocked(h.permissions.authorizeCurrent).mockResolvedValue(d);await expect(h.createProduct()).rejects.toMatchObject(error('HUMAN_GLOBAL_PRODUCT_AUTHORITY_REQUIRED',403));
  }
 });
 it('allows SERVICE only through explicit policy and never invents a human',async()=>{
  h.principal={...h.principal,kind:'SERVICE',subjectId:null,userAuthRevision:null};h.servicePolicy=false;await expect(h.createCustomer()).rejects.toMatchObject(error('EXPLICIT_SERVICE_POLICY_REQUIRED',403));
  h.servicePolicy=true;expect((await h.createCustomer()).data).toMatchObject({revision:1});expect((await h.open()).data).toMatchObject({actor:{kind:'SERVICE',subjectId:null,userAuthRevision:null}});
  await expect(h.createProduct()).rejects.toMatchObject(error('HUMAN_GLOBAL_PRODUCT_AUTHORITY_REQUIRED',403));
 });
 it('shares customers only inside the authorized issuer RUC across actors',async()=>{
  const r=await h.createCustomer();h.principal={...h.principal,subjectId:randomUUID()};expect((await h.execute('CUSTOMERS_LIST')).data).toEqual([r.data]);
  expect((await h.execute('CUSTOMERS_LIST',{binding:h.other})).data).toEqual([]);await expect(h.execute('CUSTOMERS_DETAIL',{binding:h.other,id:(r.data as BusinessCustomer).id})).rejects.toMatchObject(error('RESOURCE_NOT_FOUND',404));
  expect((await h.createCustomer({binding:h.other})).data).toMatchObject({issuerId:2});
 });
 it('enforces customer identity uniqueness on create and update',async()=>{
  await h.createCustomer();await expect(h.createCustomer()).rejects.toMatchObject(error('CUSTOMER_IDENTITY_CONFLICT',409));const b=await h.createCustomer({body:{...customer(),identityNumber:'00000000012'}});
  await expect(h.execute('CUSTOMERS_UPDATE',{id:(b.data as BusinessCustomer).id,idempotencyKey:key(),expectedRevision:1,body:{identityNumber:customer().identityNumber}})).rejects.toMatchObject(error('CUSTOMER_IDENTITY_CONFLICT',409));
 });
 it('updates customers with CAS and replays original response',async()=>{
  const c=(await h.createCustomer()).data as BusinessCustomer,input={id:c.id,idempotencyKey:key(),expectedRevision:1,body:{legalName:'NOMBRE ACTUAL'}};
  const update=await h.execute('CUSTOMERS_UPDATE',input);expect(update.data).toMatchObject({revision:2,legalName:'NOMBRE ACTUAL'});expect(await h.execute('CUSTOMERS_UPDATE',input)).toEqual({...update,replayed:true});
  await expect(h.execute('CUSTOMERS_UPDATE',{...input,idempotencyKey:key()})).rejects.toMatchObject(error('REVISION_CONFLICT',412));
  await expect(h.execute('CUSTOMERS_UPDATE',{...input,expectedRevision:undefined,idempotencyKey:key()})).rejects.toMatchObject(error('PRECONDITION_REQUIRED',428));
 });
 it('serializes identical requests and rejects key reuse with different payload/binding',async()=>{
  const input={idempotencyKey:key(),body:customer()},r=await Promise.all([h.createCustomer(input),h.createCustomer(input)]);expect(r.map(v=>v.replayed).sort()).toEqual([false,true]);expect(r[0].operationId).toBe(r[1].operationId);
  await expect(h.createCustomer({...input,body:{...customer(),legalName:'DIFERENTE'}})).rejects.toMatchObject(error('IDEMPOTENCY_CONFLICT',409));await expect(h.createCustomer({...input,binding:h.other})).rejects.toMatchObject(error('IDEMPOTENCY_CONFLICT',409));
 });
 it('bounds pagination and treats SQL wildcard/injection text literally',async()=>{
  for(let i=0;i<3;i++)await h.createCustomer({body:{...customer(),identityNumber:'0000000002'+i,legalName:'CLIENTE '+i}});
  const first=await h.execute('CUSTOMERS_LIST',{limit:2,q:'cliente'});expect(first.data).toHaveLength(2);expect(first.nextCursor).toBeTruthy();const second=await h.execute('CUSTOMERS_LIST',{limit:2,after:first.nextCursor,q:'cliente'});expect(second.data).toHaveLength(1);expect(second.nextCursor).toBeNull();
  for(const q of ['%','_',"' OR true --"])expect((await h.execute('CUSTOMERS_LIST',{q})).data).toEqual([]);
  for(const input of [{limit:0},{limit:101},{limit:1.2},{q:'a'.repeat(101)},{after:'invalid'}])await expect(h.execute('CUSTOMERS_LIST',input)).rejects.toMatchObject({status:400});
 });
 it('shares real catalogue with exact prices, global SKU uniqueness and CAS',async()=>{
  const p=(await h.createProduct()).data as BusinessProduct;expect(p.defaultUnitPrice).toBe('0.100001');expect((await h.execute('PRODUCTS_LIST',{binding:h.other})).data).toEqual([p]);
  await expect(h.createProduct({binding:h.other})).rejects.toMatchObject(error('PRODUCT_SKU_CONFLICT',409));
  expect((await h.execute('PRODUCTS_UPDATE',{id:p.id,idempotencyKey:key(),expectedRevision:1,body:{defaultUnitPrice:'0.200002'}})).data).toMatchObject({revision:2,defaultUnitPrice:'0.200002'});
  await expect(h.execute('PRODUCTS_UPDATE',{id:p.id,idempotencyKey:key(),expectedRevision:1,body:{active:false}})).rejects.toMatchObject(error('REVISION_CONFLICT',412));
 });
 it('commits exactly one simultaneous customer CAS request',async()=>{
  const p=(await h.createCustomer()).data as BusinessCustomer,r=await Promise.allSettled(['UNO','DOS'].map(legalName=>h.execute('CUSTOMERS_UPDATE',{id:p.id,idempotencyKey:key(),expectedRevision:1,body:{legalName}})));
  expect(r.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(r.filter(v=>v.status==='rejected')).toHaveLength(1);expect((await h.execute('CUSTOMERS_DETAIL',{id:p.id})).data).toMatchObject({revision:2});
 });
 it('enforces one open shift per physical point across actors series and currencies',async()=>{
  await h.open();h.principal={...h.principal,subjectId:randomUUID()};const alternate={...h.b,seriesId:randomUUID(),documentType:'03' as const};h.principal.bindings.push(alternate);
  await expect(h.open({binding:alternate,currency:'USD'})).rejects.toMatchObject(error('SHIFT_ALREADY_OPEN',409));expect((await h.open({binding:h.other})).data).toMatchObject({state:'OPEN'});
 });
 it('isolates shifts and cash by exact actor and binding',async()=>{
  const s=(await h.open()).data as BusinessShift,input={id:s.id,expectedRevision:1,idempotencyKey:key(),direction:'IN',amount:'0.20',reason:'PRUEBA'};
  await expect(h.execute('SHIFTS_CASH',{...input,binding:h.other})).rejects.toMatchObject(error('RESOURCE_NOT_FOUND',404));h.principal={...h.principal,subjectId:randomUUID()};await expect(h.execute('SHIFTS_CASH',input)).rejects.toMatchObject(error('RESOURCE_NOT_FOUND',404));expect((await h.execute('SHIFTS_LIST')).data).toEqual([]);
 });
 it('requires cash and shift scopes independently',async()=>{
  const s=(await h.open()).data as BusinessShift;h.principal={...h.principal,scopes:h.principal.scopes.filter(s=>s!=='b2b:cash:write')};await expect(h.execute('SHIFTS_CASH',{id:s.id,expectedRevision:1,idempotencyKey:key(),direction:'IN',amount:'0.20',reason:'PRUEBA'})).rejects.toMatchObject(error('INVALID_PRINCIPAL',401));
 });
 it('calculates exact cash and never reopens a closed shift',async()=>{
  let s=(await h.open()).data as BusinessShift;s=(await h.execute('SHIFTS_CASH',{id:s.id,expectedRevision:1,idempotencyKey:key(),direction:'IN',amount:'0.20',reason:'ENTRADA'})).data as BusinessShift;expect(s.balance).toBe('0.30');
  s=(await h.execute('SHIFTS_CASH',{id:s.id,expectedRevision:2,idempotencyKey:key(),direction:'OUT',amount:'0.10',reason:'SALIDA'})).data as BusinessShift;expect(s.balance).toBe('0.20');
  const input={id:s.id,expectedRevision:3,idempotencyKey:key(),countedAmount:'0.19',reason:'CIERRE'},closed=await h.execute('SHIFTS_CLOSE',input);expect(closed.data).toMatchObject({state:'CLOSED',balance:'0.20',countedAmount:'0.19',difference:'-0.01',revision:4});expect(await h.execute('SHIFTS_CLOSE',input)).toEqual({...closed,replayed:true});
  await expect(h.execute('SHIFTS_CASH',{id:s.id,expectedRevision:4,idempotencyKey:key(),direction:'IN',amount:'0.01',reason:'CERRADO'})).rejects.toMatchObject(error('SHIFT_CLOSED',409));
  await expect(h.execute('SHIFTS_CLOSE',{...input,idempotencyKey:key(),expectedRevision:4})).rejects.toMatchObject(error('SHIFT_CLOSED',409));expect((await h.open()).data).toMatchObject({state:'OPEN',revision:1});
 });
 it('rejects floating/exponent/rounded money, underflow and overflow',async()=>{
  const s=(await h.open()).data as BusinessShift,input={id:s.id,expectedRevision:1,direction:'IN',reason:'PRUEBA'};
  for(const v of ['0.001','1e2','-1','NaN',0.1,'000.10','1000000000000'])await expect(h.execute('SHIFTS_CASH',{...input,idempotencyKey:key(),amount:v})).rejects.toMatchObject(error('INVALID_AMOUNT',400));
  await expect(h.execute('SHIFTS_CASH',{...input,idempotencyKey:key(),direction:'OUT',amount:'0.11'})).rejects.toMatchObject(error('CASH_BALANCE_OUT_OF_RANGE',409));
  expect((await h.execute('SHIFTS_CASH',{...input,idempotencyKey:key(),amount:'999999999999.89'})).data).toMatchObject({balance:'999999999999.99'});
  await expect(h.execute('SHIFTS_CASH',{...input,expectedRevision:2,idempotencyKey:key(),amount:'0.01'})).rejects.toMatchObject(error('CASH_BALANCE_OUT_OF_RANGE',409));
 });
 it('concurrent cash and close commit a single revision',async()=>{
  const s=(await h.open()).data as BusinessShift,r=await Promise.allSettled([h.execute('SHIFTS_CASH',{id:s.id,expectedRevision:1,idempotencyKey:key(),direction:'IN',amount:'0.20',reason:'ENTRADA'}),h.execute('SHIFTS_CLOSE',{id:s.id,expectedRevision:1,idempotencyKey:key(),countedAmount:'0.10',reason:'CIERRE'})]);expect(r.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(r.filter(v=>v.status==='rejected')).toHaveLength(1);expect((await h.execute('SHIFTS_LIST')).data).toEqual([expect.objectContaining({revision:2})]);
 });
 it('revalidates Identity at commit and rolls back resource movement and audit',async()=>{
  const base=h.identity.authenticate.getMockImplementation()!;h.identity.authenticate.mockImplementation(async(...args)=>{const p=await base(...args);if(h.identity.authenticate.mock.calls.length>=4)p.revision++;return p;});await expect(h.open()).rejects.toMatchObject(error('ACCESS_CHANGED',401));h.identity.authenticate.mockImplementation(base);expect((await h.execute('SHIFTS_LIST')).data).toEqual([]);expect((await h.open()).data).toMatchObject({revision:1});
 });
 it('revalidates owner authority at commit and replay',async()=>{
  const original=vi.mocked(h.permissions.authorizeCurrent).getMockImplementation()!;vi.mocked(h.permissions.authorizeCurrent).mockImplementation(async r=>{const d=await original(r);if(h.calls===3)d.revision='2';return d;});await expect(h.createCustomer()).rejects.toMatchObject(error('OWNER_ACCESS_CHANGED',401));vi.mocked(h.permissions.authorizeCurrent).mockImplementation(original);expect((await h.execute('CUSTOMERS_LIST')).data).toEqual([]);
  const input={idempotencyKey:key(),body:product()};await h.createProduct(input);h.global=false;await expect(h.createProduct(input)).rejects.toMatchObject(error('HUMAN_GLOBAL_PRODUCT_AUTHORITY_REQUIRED',403));
 });
 it('revalidates current owner context before returning reads',async()=>{
  const original=vi.mocked(h.permissions.authorizeCurrent).getMockImplementation()!;vi.mocked(h.permissions.authorizeCurrent).mockImplementation(async r=>{const d=await original(r);if(h.calls===2)h.contextActive=false;return d;});await expect(h.execute('CUSTOMERS_LIST')).rejects.toMatchObject(error('RESOURCE_NOT_FOUND',404));
 });
 it('rejects actor injection unknown fields and invalid idempotency keys',async()=>{
  await expect(h.createCustomer({actor:{kind:'USER'}})).rejects.toMatchObject({status:400});await expect(h.createCustomer({body:{...customer(),issuerId:2}})).rejects.toMatchObject({status:400});await expect(h.createCustomer({idempotencyKey:'short'})).rejects.toMatchObject(error('INVALID_IDEMPOTENCY_KEY',400));
 });
 it('reports actual scoped counts and cash without implying sales or stock',async()=>{
  await h.createCustomer();await h.createProduct();const s=(await h.open({openingAmount:'10.00'})).data as BusinessShift;await h.execute('SHIFTS_CASH',{id:s.id,expectedRevision:1,idempotencyKey:key(),direction:'IN',amount:'0.20',reason:'ENTRADA'});
  const report=await h.execute('REPORTS_SUMMARY');expect(report.data).toMatchObject({customers:'1',activeCustomers:'1',sharedProducts:'1',actorPointShifts:'1',actorPointOpenShifts:'1',cash:[{currency:'PEN',incoming:'0.20',outgoing:'0.00'}]});expect(JSON.stringify(report.data)).not.toMatch(/sales|venta|stock/i);expect((await h.execute('REPORTS_SUMMARY',{binding:h.other})).data).toMatchObject({customers:'0',sharedProducts:'1',actorPointShifts:'0',cash:[]});
 });
}


