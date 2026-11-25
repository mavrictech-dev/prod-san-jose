import type {ProductionStore,ProductionTx} from './b2b-production-contract';
export interface NativeB2bDatabase {$transaction<T>(work:(tx:any)=>Promise<T>,options?:{timeout:number}):Promise<T>}
/** Uses the current owner's database and migration-managed journal. Never creates schema at startup. */
export class NativeB2bPrismaStore implements ProductionStore {
 constructor(private readonly db:NativeB2bDatabase){}
 transaction<T>(keys:string[],work:(tx:ProductionTx)=>Promise<T>):Promise<T>{
  return this.db.$transaction(async db=>{
   await db.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
   for(const key of [...new Set(keys)].sort())await db.$executeRawUnsafe('SELECT pg_advisory_xact_lock(731019,hashtext($1))',key);
   const tx:ProductionTx={
    get:async<V>(namespace:string,id:string)=>{const rows=await db.$queryRawUnsafe('SELECT value FROM b2b_production_record WHERE namespace=$1 AND id=$2',namespace,id);return rows[0]?.value as V??null;},
    put:async(namespace,id,value)=>{await db.$executeRawUnsafe('INSERT INTO b2b_production_record(namespace,id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()',namespace,id,JSON.stringify(value));},
    list:async<V>(namespace:string)=>{const rows=await db.$queryRawUnsafe('SELECT id,value FROM b2b_production_record WHERE namespace=$1 ORDER BY id LIMIT 10001',namespace);if(rows.length>10000)throw Error('NATIVE_B2B_NAMESPACE_REQUIRES_PAGED_QUERY');return rows as Array<{id:string;value:V}>;},
   };return work(tx);
  },{timeout:15000});
 }
}
