import type { B2bBinding, B2bPrincipal } from '@factuez/contracts/b2b-security';
export type { B2bBinding, B2bPrincipal };
export type BusinessAction = keyof BusinessInputMap;
export interface BusinessAuth { token: string; kind: 'USER' | 'SERVICE' }
export interface BusinessScope { issuerId: number; issuerRuc: string; environment: 'BETA' }
export interface BusinessQuery { limit?: number; after?: string; q?: string }
export interface CustomerBody { identityType: '1'|'4'|'6'|'7'|'A'; identityNumber: string; legalName: string; address: string|null; email: string|null; active: boolean }
export interface ProductBody { sku: string; description: string; category: string; unitCode: string; taxAffectationCode: string; defaultUnitPrice: string|null; active: boolean }
export interface BusinessBaseInput { binding: B2bBinding }
export interface BusinessWriteInput extends BusinessBaseInput { idempotencyKey: string }
export interface BusinessInputMap {
  CUSTOMERS_LIST: BusinessBaseInput & BusinessQuery;
  CUSTOMERS_DETAIL: BusinessBaseInput & { id: string };
  CUSTOMERS_CREATE: BusinessWriteInput & { body: CustomerBody };
  CUSTOMERS_UPDATE: BusinessWriteInput & { id: string; expectedRevision: number; body: Partial<CustomerBody> };
  PRODUCTS_LIST: BusinessBaseInput & BusinessQuery;
  PRODUCTS_CREATE: BusinessWriteInput & { body: ProductBody };
  PRODUCTS_UPDATE: BusinessWriteInput & { id: string; expectedRevision: number; body: Partial<ProductBody> };
  SHIFTS_LIST: BusinessBaseInput & BusinessQuery;
  SHIFTS_OPEN: BusinessWriteInput & { openingAmount: string; currency: 'PEN'|'USD' };
  SHIFTS_CLOSE: BusinessWriteInput & { id: string; expectedRevision: number; countedAmount: string; reason: string };
  SHIFTS_CASH: BusinessWriteInput & { id: string; expectedRevision: number; direction: 'IN'|'OUT'; amount: string; reason: string };
  REPORTS_SUMMARY: BusinessBaseInput;
}
export interface BusinessResult<T = unknown> {
  data: T; operationId: string|null; replayed: boolean; nextCursor?: string|null;
}
export interface BusinessExecutor {
  execute<A extends BusinessAction>(auth: BusinessAuth, action: A, input: BusinessInputMap[A]): Promise<BusinessResult>;
}
export interface Versioned { id: string; revision: number; createdAt: string; updatedAt: string }
export interface BusinessCustomer extends Versioned, CustomerBody, BusinessScope {}
/** Real shared FuelProduct catalogue with a CAS-only sidecar. No issuer ownership is inferred. */
export interface BusinessProduct extends Versioned, ProductBody {}
export interface BusinessShift extends Versioned {
  binding: B2bBinding; actorKey: string; actor: BusinessActor; state: 'OPEN'|'CLOSED'; currency: 'PEN'|'USD';
  openingAmount: string; balance: string; countedAmount: string|null; difference: string|null; closedAt: string|null;
}
export type BusinessActor = Pick<B2bPrincipal, 'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>;
export interface BusinessMovement {
  id: string; shiftId: string; revision: number; kind: 'OPEN'|'IN'|'OUT'|'CLOSE';
  amount: string; balanceAfter: string; reason: string; actor: BusinessActor; at: string;
}
/** Trusted local owner adapter only. Public bodies must never populate this port or its decision.
 * authorizeCurrent MUST consult current owner permissions/admin/step-up and service policy.
 * A B2B scope or RUC grant alone is never an owner permission. Called before work and before commit.
 */
export interface BusinessPermissionPort {
  authorizeCurrent(request: { principal: B2bPrincipal; binding: B2bBinding; action: BusinessAction }): Promise<BusinessPermissionDecision>;
}
export interface BusinessPermissionDecision {
  allowed: true; revision: string;
  /** Required for every SERVICE action, attributable to a live explicit owner policy. */
  servicePolicyId?: string;
  /** Required for global catalogue writes, independently of the invoking RUC binding. */
  globalProductAuthority?: { subjectId: string; userAuthRevision: number; scope: 'GLOBAL'; stepUpVerified: true; permissions: readonly string[] };
}
export interface BusinessOperation {
  id: string; actorKey: string; actor: BusinessActor; keyHash: string; requestHash: string;
  action: BusinessAction; binding: B2bBinding; resourceId: string; beforeRevision: number|null;
  afterRevision: number; permissionRevision: string; servicePolicyId: string|null; at: string; response: BusinessResult;
}
export interface BoundedQuery { limit: number; after: string|null; q: string }
export interface BusinessSummary {
  customers: string; activeCustomers: string; sharedProducts: string;
  actorPointShifts: string; actorPointOpenShifts: string;
  /** Cash movements are not commercial sales. Totals remain separated by currency. */
  cash: { currency: 'PEN'|'USD'; incoming: string; outgoing: string }[];
}
export interface BusinessTransaction {
  prior(actorKey: string, keyHash: string): Promise<BusinessOperation|null>;
  append(operation: BusinessOperation): Promise<void>;
  customers(scope: BusinessScope, query: BoundedQuery): Promise<BusinessCustomer[]>;
  customer(scope: BusinessScope, id: string): Promise<BusinessCustomer|null>;
  createCustomer(row: BusinessCustomer): Promise<void>;
  saveCustomer(row: BusinessCustomer, expectedRevision: number): Promise<void>;
  products(query: BoundedQuery): Promise<BusinessProduct[]>;
  product(id: string): Promise<BusinessProduct|null>;
  createProduct(row: BusinessProduct): Promise<void>;
  saveProduct(row: BusinessProduct, expectedRevision: number): Promise<void>;
  shifts(binding: B2bBinding, actorKey: string, query: BoundedQuery): Promise<BusinessShift[]>;
  shift(binding: B2bBinding, actorKey: string, id: string): Promise<BusinessShift|null>;
  createShift(row: BusinessShift): Promise<void>;
  saveShift(row: BusinessShift, expectedRevision: number): Promise<void>;
  movement(row: BusinessMovement): Promise<void>;
  movementBalance(shiftId: string): Promise<string>;
  summary(scope: BusinessScope, binding: B2bBinding, actorKey: string): Promise<BusinessSummary>;
}
export interface BusinessStore {
  transaction<T>(lockKeys: readonly string[], work: (tx: BusinessTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

