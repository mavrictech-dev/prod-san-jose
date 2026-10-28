import { createHash, randomUUID } from 'node:crypto';
import { B2bSecurityError, b2bBindingsContain, validB2bBinding, b2bBindingKey, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import type { ContextRepository } from '../context';
import type { BusinessAction, BusinessActor, BusinessAuth, BusinessExecutor, BusinessInputMap, BusinessOperation, BusinessPermissionDecision, BusinessPermissionPort, BusinessResult, BusinessShift, BusinessStore, B2bPrincipal, B2bBinding } from './types';
import { amount, checkedBalance, customerBody, ExactDecimal, fail, keys, object, productBody, query, revision, text, uuid } from './validation';

const actions = ['CUSTOMERS_LIST','CUSTOMERS_DETAIL','CUSTOMERS_CREATE','CUSTOMERS_UPDATE','PRODUCTS_LIST','PRODUCTS_CREATE','PRODUCTS_UPDATE','SHIFTS_LIST','SHIFTS_OPEN','SHIFTS_CLOSE','SHIFTS_CASH','REPORTS_SUMMARY'] as const;
const writes = new Set<BusinessAction>(['CUSTOMERS_CREATE','CUSTOMERS_UPDATE','PRODUCTS_CREATE','PRODUCTS_UPDATE','SHIFTS_OPEN','SHIFTS_CLOSE','SHIFTS_CASH']);
const productWrite = (a: BusinessAction) => a === 'PRODUCTS_CREATE' || a === 'PRODUCTS_UPDATE';
export const businessActorKey = (p: B2bPrincipal): string => `${p.kind}:${p.clientId}:${p.subjectId ?? '-'}`;
const actor = ({kind,clientId,revision,subjectId,userAuthRevision}: B2bPrincipal): BusinessActor => ({kind,clientId,revision,subjectId,userAuthRevision});
function scopes(a: BusinessAction): B2bIdentityScope[] {
  // Main owns activation of the new scope vocabulary in contracts/Identity.
  const values: B2bIdentityScope[] = a.startsWith('CUSTOMERS_') ? [writes.has(a)?'b2b:customers:write':'b2b:customers:read'] :
    a.startsWith('PRODUCTS_') ? [writes.has(a)?'b2b:products:write':'b2b:products:read'] :
    a === 'SHIFTS_CASH' ? ['b2b:shifts:write','b2b:cash:write'] :
    a === 'REPORTS_SUMMARY' ? ['b2b:reports:read','b2b:customers:read','b2b:products:read','b2b:shifts:read'] :
    [writes.has(a)?'b2b:shifts:write':'b2b:shifts:read'];
  return values;
}
const fields: Record<BusinessAction, string[]> = {
  CUSTOMERS_LIST:['limit','after','q'], CUSTOMERS_DETAIL:['id'], CUSTOMERS_CREATE:['body'], CUSTOMERS_UPDATE:['id','expectedRevision','body'],
  PRODUCTS_LIST:['limit','after','q'], PRODUCTS_CREATE:['body'], PRODUCTS_UPDATE:['id','expectedRevision','body'],
  SHIFTS_LIST:['limit','after','q'], SHIFTS_OPEN:['openingAmount','currency'], SHIFTS_CLOSE:['id','expectedRevision','countedAmount','reason'],
  SHIFTS_CASH:['id','expectedRevision','direction','amount','reason'], REPORTS_SUMMARY:[],
};
/** Candidate owner engine. No controller, legacy factory, issuance, stock inference or deployment side effects. */
export class B2bPhase8Business implements BusinessExecutor {
  constructor(private readonly store: BusinessStore, private readonly identity: B2bIdentityPort,
    private readonly context: ContextRepository, private readonly permissions: BusinessPermissionPort|null = null,
    private readonly now: () => number = Date.now) {}

  async execute<A extends BusinessAction>(auth: BusinessAuth, action: A, input: BusinessInputMap[A]): Promise<BusinessResult> {
    const a = object(auth);
    keys(a,['token','kind'],['token','kind']);
    if (typeof a.token !== 'string' || !a.token || a.token.length > 16384 || !['USER','SERVICE'].includes(String(a.kind)) || !actions.includes(action)) fail(400,'INVALID_REQUEST');
    // Clone before awaits: the caller cannot mutate the authorized binding/body while Identity runs.
    let raw: Record<string, unknown>;
    try { raw = object(structuredClone(input)); } catch { return fail(400,'INVALID_REQUEST'); }
    const requiredFields = action.endsWith('_LIST') || action === 'REPORTS_SUMMARY' ? [] : fields[action];
    if (fields[action].includes('expectedRevision')) revision(raw.expectedRevision);
    keys(raw,['binding',...fields[action],...(writes.has(action)?['idempotencyKey']:[])],['binding',...requiredFields,...(writes.has(action)?['idempotencyKey']:[])]);
    if (!validB2bBinding(raw.binding)) fail(400,'INVALID_BINDING');
    const binding = raw.binding as B2bBinding;
    let encoded: string;
    try { encoded = JSON.stringify(raw); snapshotHash(raw); } catch { return fail(400,'INVALID_REQUEST'); }
    if (Buffer.byteLength(encoded) > 16384) fail(413,'REQUEST_TOO_LARGE');
    const required = scopes(action), frame = new B2bOwnerReadFrame(this.identity,auth.kind);
    const principal = await frame.principal(auth.token,required);
    if (!b2bBindingsContain(principal.bindings,binding)) fail(404,'RESOURCE_NOT_FOUND');
    if (productWrite(action) && principal.kind !== 'USER') fail(403,'HUMAN_GLOBAL_PRODUCT_AUTHORITY_REQUIRED');
    if (!this.permissions) fail(503,'OWNER_PERMISSION_PORT_REQUIRED');
    const owner = businessActorKey(principal), scope = {issuerId:binding.issuerId,issuerRuc:binding.issuerRuc,environment:'BETA' as const};
    let permissionStamp: string|null = null;
    const current = async (): Promise<BusinessPermissionDecision> => {
      const p = await frame.principal(auth.token,required);
      if (!b2bBindingsContain(p.bindings,binding)) fail(404,'RESOURCE_NOT_FOUND');
      let resolved: unknown;
      try { resolved = await this.context.resolve(binding); }
      catch (e) { if (e instanceof B2bSecurityError) throw e; return fail(503,'BUSINESS_CONTEXT_UNAVAILABLE'); }
      if (!resolved) fail(404,'RESOURCE_NOT_FOUND');
      let d: BusinessPermissionDecision;
      try { d = await this.permissions!.authorizeCurrent({principal:structuredClone(p),binding:structuredClone(binding),action}); }
      catch (e) { if (e instanceof B2bSecurityError) throw e; return fail(503,'OWNER_PERMISSION_UNAVAILABLE'); }
      if (!d || d.allowed !== true || typeof d.revision !== 'string' || !d.revision || d.revision.length > 200) fail(403,'OWNER_PERMISSION_DENIED');
      if (p.kind === 'SERVICE' && (typeof d.servicePolicyId !== 'string' || !d.servicePolicyId.trim() || d.servicePolicyId.length > 200)) fail(403,'EXPLICIT_SERVICE_POLICY_REQUIRED');
      if (productWrite(action)) {
        const h = d.globalProductAuthority;
        if (p.kind !== 'USER' || !h || h.subjectId !== p.subjectId || h.userAuthRevision !== p.userAuthRevision ||
            h.scope !== 'GLOBAL' || h.stepUpVerified !== true || !Array.isArray(h.permissions) || !h.permissions.includes('product.manage')) fail(403,'HUMAN_GLOBAL_PRODUCT_AUTHORITY_REQUIRED');
      }
      const stamp = snapshotHash(d);
      if (permissionStamp !== null && permissionStamp !== stamp) fail(401,'OWNER_ACCESS_CHANGED');
      permissionStamp = stamp;
      return structuredClone(d);
    };
    await current();
    const write = writes.has(action), lockKeys: string[] = [];
    let keyHash = '', requestHash = '';
    if (write) {
      if (typeof raw.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(raw.idempotencyKey)) fail(400,'INVALID_IDEMPOTENCY_KEY');
      keyHash = createHash('sha256').update(raw.idempotencyKey as string).digest('hex');
      const {idempotencyKey:_key,...request} = raw;
      requestHash = snapshotHash({action,input:request});
      lockKeys.push(`phase8:idem:${owner}:${keyHash}`);
      lockKeys.push(productWrite(action)?'phase8:products:global':action.startsWith('CUSTOMERS_')?
        `phase8:customers:${binding.issuerId}:${binding.issuerRuc}`:`phase8:point:${binding.issuerId}:${binding.issuerRuc}:${binding.branchId}:${binding.pointId}`);
    }
    try { return await this.store.transaction(lockKeys,async tx => {
      const decision = await current();
      if (write) {
        const prior = await tx.prior(owner,keyHash);
        if (prior) {
          if (prior.requestHash !== requestHash || prior.action !== action || b2bBindingKey(prior.binding) !== b2bBindingKey(binding)) fail(409,'IDEMPOTENCY_CONFLICT');
          await current();
          return {...structuredClone(prior.response),replayed:true};
        }
      }
      if (!write) {
        let result: BusinessResult;
        if (action === 'CUSTOMERS_DETAIL') {
          if (!uuid(raw.id)) fail(400,'INVALID_ID');
          const found = await tx.customer(scope,raw.id as string);
          if (!found) fail(404,'RESOURCE_NOT_FOUND');
          result = {data:found,operationId:null,replayed:false};
        } else if (action === 'REPORTS_SUMMARY') {
          result = {data:await tx.summary(scope,binding,owner),operationId:null,replayed:false};
        } else {
          const q = query(raw), bounded = {...q,limit:q.limit+1};
          const rows = action === 'CUSTOMERS_LIST' ? await tx.customers(scope,bounded) :
            action === 'PRODUCTS_LIST' ? await tx.products(bounded) : await tx.shifts(binding,owner,bounded);
          result = {data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,operationId:null,replayed:false};
        }
        await current(); return result;
      }
      const at = new Date(this.now()).toISOString();
      let resource: {id:string;revision:number}, beforeRevision: number|null = null;
      if (action === 'CUSTOMERS_CREATE') {
        const row = {...customerBody(raw.body),...scope,id:randomUUID(),revision:1,createdAt:at,updatedAt:at};
        await tx.createCustomer(row); resource = row;
      } else if (action === 'CUSTOMERS_UPDATE') {
        if (!uuid(raw.id)) fail(400,'INVALID_ID');
        const expected = revision(raw.expectedRevision), before = await tx.customer(scope,raw.id as string);
        if (!before) fail(404,'RESOURCE_NOT_FOUND');
        if (before!.revision !== expected) fail(412,'REVISION_CONFLICT');
        const row = {...before!,...customerBody(raw.body,before!),revision:expected+1,updatedAt:at};
        await tx.saveCustomer(row,expected); resource = row; beforeRevision = expected;
      } else if (productWrite(action)) {
        if (action === 'PRODUCTS_CREATE') {
          const row = {...productBody(raw.body),id:randomUUID(),revision:1,createdAt:at,updatedAt:at};
          await tx.createProduct(row); resource = row;
        } else {
          if (!uuid(raw.id)) fail(400,'INVALID_ID');
          const expected = revision(raw.expectedRevision), before = await tx.product(raw.id as string);
          if (!before) fail(404,'RESOURCE_NOT_FOUND');
          if (before!.revision !== expected) fail(412,'REVISION_CONFLICT');
          const row = {...before!,...productBody(raw.body,before!),revision:expected+1,updatedAt:at};
          await tx.saveProduct(row,expected); resource = row; beforeRevision = expected;
        }
      } else if (action === 'SHIFTS_OPEN') {
        if (!['PEN','USD'].includes(String(raw.currency))) fail(400,'INVALID_CURRENCY');
        const openingAmount = amount(raw.openingAmount);
        const row: BusinessShift = {id:randomUUID(),binding,actorKey:owner,actor:actor(principal),revision:1,state:'OPEN',
          currency:raw.currency as 'PEN'|'USD',openingAmount,balance:openingAmount,countedAmount:null,difference:null,closedAt:null,createdAt:at,updatedAt:at};
        await tx.createShift(row);
        await tx.movement({id:randomUUID(),shiftId:row.id,revision:1,kind:'OPEN',amount:openingAmount,balanceAfter:openingAmount,reason:'OPEN',actor:actor(principal),at});
        resource = row;
      } else {
        if (!uuid(raw.id)) fail(400,'INVALID_ID');
        const expected = revision(raw.expectedRevision), before = await tx.shift(binding,owner,raw.id as string);
        if (!before) fail(404,'RESOURCE_NOT_FOUND');
        if (before!.revision !== expected) fail(412,'REVISION_CONFLICT');
        if (before!.state !== 'OPEN') fail(409,'SHIFT_CLOSED');
        const actual = await tx.movementBalance(before!.id);
        if (!new ExactDecimal(actual).eq(before!.balance)) fail(409,'CASH_LEDGER_INCONSISTENT');
        const reason = text(raw.reason,300);
        let row: BusinessShift, movementAmount: string, movementKind: 'IN'|'OUT'|'CLOSE';
        if (action === 'SHIFTS_CASH') {
          if (!['IN','OUT'].includes(String(raw.direction))) fail(400,'INVALID_DIRECTION');
          movementAmount = amount(raw.amount,2,true); movementKind = raw.direction as 'IN'|'OUT';
          const balance = checkedBalance(new ExactDecimal(actual)[movementKind === 'IN'?'plus':'minus'](movementAmount));
          row = {...before!,balance,revision:expected+1,updatedAt:at};
        } else {
          movementAmount = amount(raw.countedAmount); movementKind = 'CLOSE';
          row = {...before!,state:'CLOSED',countedAmount:movementAmount,difference:new ExactDecimal(movementAmount).minus(actual).toFixed(2),closedAt:at,revision:expected+1,updatedAt:at};
        }
        await tx.saveShift(row,expected);
        await tx.movement({id:randomUUID(),shiftId:row.id,revision:row.revision,kind:movementKind,amount:movementAmount,balanceAfter:row.balance,reason,actor:actor(principal),at});
        resource = row; beforeRevision = expected;
      }
      const response: BusinessResult = {data:resource,operationId:randomUUID(),replayed:false};
      const operation: BusinessOperation = {id:response.operationId!,actorKey:owner,actor:actor(principal),keyHash,requestHash,action,binding,
        resourceId:resource.id,beforeRevision,afterRevision:resource.revision,permissionRevision:decision.revision,
        servicePolicyId:principal.kind === 'SERVICE'?decision.servicePolicyId!:null,at,response};
      await tx.append(operation);
      await current();
      return response;
    }); } catch (e) {
      if (e instanceof B2bSecurityError) throw e;
      throw new B2bSecurityError(503,'BUSINESS_STORE_UNAVAILABLE');
    }
  }
  close(): Promise<void> { return this.store.close(); }
}
