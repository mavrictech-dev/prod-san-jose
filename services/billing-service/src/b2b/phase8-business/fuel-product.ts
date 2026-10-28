import { snapshotHash } from '@factuez/service-access/dist/integration';
import type { BusinessProduct } from './types';
import { ExactDecimal } from './validation';
/** Every actual FuelProduct field participates, including the legacy-only SUNAT code. */
export interface FuelProductRow {
 id:string;sku:string;description:string;category:string;sunatProductCode:string|null;unitCode:string;taxAffectationCode:string;
 defaultUnitPrice:string|null;active:boolean;createdAt:string;updatedAt:string;
}
export const fuelColumns = `id,sku,description,category,"sunatProductCode","unitCode","taxAffectationCode",
 "defaultUnitPrice"::text AS "defaultUnitPrice",active,"createdAt"::text AS "createdAt","updatedAt"::text AS "updatedAt"`;
export function fuelFingerprint(row:FuelProductRow):string { return snapshotHash(row); }
export function fuelView(row:FuelProductRow,revision:number):BusinessProduct {
 return {id:row.id,sku:row.sku,description:row.description,category:row.category,unitCode:row.unitCode,
  taxAffectationCode:row.taxAffectationCode,defaultUnitPrice:row.defaultUnitPrice===null?null:new ExactDecimal(row.defaultUnitPrice).toFixed(6),
  active:row.active,revision,createdAt:new Date(row.createdAt.replace(' ','T')+'Z').toISOString(),updatedAt:new Date(row.updatedAt.replace(' ','T')+'Z').toISOString()};
}

