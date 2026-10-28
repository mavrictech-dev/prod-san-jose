import { isRucStructurallyValid } from '@factuez/sunat-core';

export type ProductionSoapOperation = 'sendBill' | 'sendSummary' | 'getStatus';
export type ProductionSoapRequest = Readonly<{
  environment: 'PRODUCTION'; ruc: string; operation: ProductionSoapOperation;
}>;
declare const productionSoapAuthorizationBrand: unique symbol;
/** In-process capability. Never accept this from a controller, JSON or environment flag. */
export type ProductionSoapAuthorization = { readonly [productionSoapAuthorizationBrand]: true };
type Grant = {
  ruc: string; operations: readonly ProductionSoapOperation[];
  assertCurrent: (request: ProductionSoapRequest) => void | Promise<void>;
};
const grants = new WeakMap<object, Readonly<Grant>>();
const operations: readonly ProductionSoapOperation[] = ['sendBill', 'sendSummary', 'getStatus'];
const denied = () => new Error('Transmisión de producción deshabilitada: autorización privada requerida');

/** Trusted private composition only. The owner must re-read its current authorization on every call.
 * Returning normally authorizes this exact RUC/operation; denial must throw. No DTO booleans.
 * This factory does not wire or enable a runtime, load credentials, or establish fiscal readiness. */
export function createProductionSoapAuthorization(
  scope: Readonly<{ ruc: string; operations: readonly ProductionSoapOperation[] }>,
  assertCurrent: Grant['assertCurrent'],
): ProductionSoapAuthorization {
  if (!scope || !isRucStructurallyValid(scope.ruc) || !Array.isArray(scope.operations) ||
      !scope.operations.length || scope.operations.some(value => !operations.includes(value)) ||
      new Set(scope.operations).size !== scope.operations.length || typeof assertCurrent !== 'function') throw denied();
  const capability = Object.freeze(Object.create(null)) as ProductionSoapAuthorization;
  grants.set(capability, Object.freeze({ ruc: scope.ruc, operations: Object.freeze([...scope.operations]), assertCurrent }));
  return capability;
}
export function revokeProductionSoapAuthorization(capability: ProductionSoapAuthorization): void {
  grants.delete(capability);
}
export function hasProductionSoapAuthorization(capability: unknown, ruc: string): capability is ProductionSoapAuthorization {
  if (!capability || typeof capability !== 'object') return false;
  return grants.get(capability)?.ruc === ruc;
}
export async function assertProductionSoapAuthorized(capability: unknown, ruc: string, operation: ProductionSoapOperation): Promise<void> {
  if (!hasProductionSoapAuthorization(capability, ruc)) throw denied();
  const grant = grants.get(capability)!;
  if (!grant.operations.includes(operation)) throw denied();
  try {
    const result = await grant.assertCurrent(Object.freeze({ environment: 'PRODUCTION', ruc, operation }));
    // Reject accidental true/false or serialized approval results, even from untyped callers.
    if (result !== undefined || grants.get(capability) !== grant) throw denied();
  } catch { throw denied(); } // Owner diagnostics must never expose credentials or private policy.
}
