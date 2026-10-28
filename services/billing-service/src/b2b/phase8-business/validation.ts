import { Decimal } from '@prisma/client/runtime/client';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import type { BoundedQuery, CustomerBody, ProductBody } from './types';
export const ExactDecimal = Decimal.clone({ precision: 40 });
export const fail = (status: number, code: string): never => { throw new B2bSecurityError(status, code); };
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) fail(400,'INVALID_REQUEST');
  return v as Record<string, unknown>;
}
export function keys(v: Record<string, unknown>, allowed: readonly string[], required: readonly string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v,k))) fail(400,'INVALID_REQUEST');
}
export function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(v)) fail(400,'INVALID_TEXT');
  return (v as string).trim();
}
export function amount(v: unknown, scale = 2, positive = false): string {
  const pattern = new RegExp('^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,'+scale+'})?$');
  if (typeof v !== 'string' || !pattern.test(v)) fail(400,'INVALID_AMOUNT');
  const n = new ExactDecimal(v as string);
  if (positive && !n.gt(0)) fail(400,'INVALID_AMOUNT');
  return n.toFixed(scale);
}
export function checkedBalance(v: InstanceType<typeof ExactDecimal>): string {
  if (v.lt(0) || v.gt('999999999999.99')) fail(409,'CASH_BALANCE_OUT_OF_RANGE');
  return v.toFixed(2);
}
export function revision(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v >= 2147483647) fail(428,'PRECONDITION_REQUIRED');
  return v as number;
}
export function query(v: Record<string, unknown>): BoundedQuery {
  if (v.limit !== undefined && (typeof v.limit !== 'number' || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 100)) fail(400,'INVALID_QUERY');
  if (v.after !== undefined && !uuid(v.after)) fail(400,'INVALID_QUERY');
  if (v.q !== undefined && typeof v.q !== 'string') fail(400,'INVALID_QUERY');
  const q = v.q === undefined || v.q === '' ? '' : text(v.q,100);
  return {limit: v.limit as number ?? 50, after: v.after as string ?? null, q};
}
export function customerBody(v: unknown, previous?: CustomerBody): CustomerBody {
  const b = object(v), fields = ['identityType','identityNumber','legalName','address','email','active'];
  keys(b,fields,previous ? [] : fields);
  if (!Object.keys(b).length) fail(400,'EMPTY_PATCH');
  const c = {...previous,...b} as CustomerBody;
  if (!['1','4','6','7','A'].includes(c.identityType)) fail(400,'INVALID_IDENTITY');
  const identityNumber = text(c.identityNumber,15);
  if (!(c.identityType === '1' ? /^[0-9]{8}$/ : c.identityType === '6' ? /^[0-9]{11}$/ : /^[A-Z0-9]{3,15}$/).test(identityNumber)) fail(400,'INVALID_IDENTITY');
  const address = c.address === null ? null : text(c.address,300);
  const email = c.email === null ? null : text(c.email,254);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'INVALID_EMAIL');
  if (typeof c.active !== 'boolean') fail(400,'INVALID_ACTIVE');
  return {identityType:c.identityType,identityNumber,legalName:text(c.legalName,250),address,email,active:c.active};
}
export function productBody(v: unknown, previous?: ProductBody): ProductBody {
  const b = object(v), fields = ['sku','description','category','unitCode','taxAffectationCode','defaultUnitPrice','active'];
  keys(b,fields,previous ? [] : fields);
  if (!Object.keys(b).length) fail(400,'EMPTY_PATCH');
  const p = {...previous,...b} as ProductBody;
  const sku = text(p.sku,40);
  if (!/^(?:[A-Z0-9]{3}|ZZ|M3)$/.test(p.unitCode) ||
      !/^(10|11|12|13|14|15|16|17|20|21|30|31|32|33|34|35|36|37|40)$/.test(p.taxAffectationCode) || typeof p.active !== 'boolean') fail(400,'INVALID_PRODUCT');
  return {sku,description:text(p.description,250),category:text(p.category,80),unitCode:p.unitCode,
    taxAffectationCode:p.taxAffectationCode,defaultUnitPrice:p.defaultUnitPrice === null ? null : amount(p.defaultUnitPrice,6),active:p.active};
}

