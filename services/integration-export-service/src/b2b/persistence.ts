import { PostgresExportStore,type ExportPool } from '../postgres-store';
import { PostgresChangeDeliveryStore } from '../change-store';
import { ExportVault } from '../vault';
import type { B2bExtractionPersistence } from './core';
/** Deployment factory: fail closed rather than attach a B2B worker to the legacy queue. */
export async function b2bExtractionPersistence(pool:ExportPool,key:Buffer):Promise<B2bExtractionPersistence>{
  const stores=await checkB2bExtractionStorage(pool);
  return {domain:'B2B_BETA_ISOLATED',...stores,vault:new ExportVault(key)};
}
/** Storage-only readiness: does not reload/retain a key for each metadata probe. */
export async function checkB2bExtractionStorage(pool:ExportPool){
  const rows=await pool.query('SELECT current_database() AS name');if(rows.rows.length!==1||rows.rows[0].name!=='b2b_exports_beta')throw new Error('Dedicated b2b_exports_beta database required');
  const exports=new PostgresExportStore(pool),changes=new PostgresChangeDeliveryStore(pool);await exports.readySchema();await changes.readySchema();
  return {exports,changes};
}
