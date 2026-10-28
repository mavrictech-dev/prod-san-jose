import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PostgresBusinessStore, type BusinessProduct, type BusinessShift, type BusinessPgPool } from '../../services/billing-service/src/b2b/phase8-business';
import { businessCases } from './cases';
import { harness, product } from '../helpers/b2b-phase8-business.fixture';
const container=process.env.FACTUEZ_P8_TEST_CONTAINER;
if(process.env.FACTUEZ_P8_ISOLATED_ONLY!=='yes'||!container||!/^[a-f0-9]{64}$/.test(container))throw new Error('EXPLICIT_ISOLATED_RUNNER_REQUIRED');
type Pool=BusinessPgPool & {query:(sql:string,values?:unknown[])=>Promise<{rows:any[];rowCount:number|null}>};
let pool:Pool;
beforeAll(async()=>{
 const result=spawnSync('docker',['inspect','--format','{{json .}}',container],{encoding:'utf8',windowsHide:true});
 if(result.status!==0)throw new Error('ISOLATED_INSPECT_FAILED');const info=JSON.parse(result.stdout);
 expect(info.Config.Labels['factuez.phase8.business.test']).toBe(process.env.FACTUEZ_P8_TEST_RUN);expect(info.HostConfig.NetworkMode).toBe('none');expect(info.HostConfig.PortBindings??{}).toEqual({});expect(info.Mounts.every((m:any)=>m.Type==='tmpfs')).toBe(true);
 class Stream extends Duplex {
  child:ReturnType<typeof spawn>|undefined;
  constructor(){super({allowHalfOpen:false});}setNoDelay(){return this;}setKeepAlive(){return this;}ref(){return this;}unref(){return this;}
  connect(port:number,host:string){if(port!==5432||host!=='127.0.0.1')throw new Error('ISOLATED_HOST_REQUIRED');
   this.child=spawn('docker',['exec','-i',container!,'nc','127.0.0.1','5432'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
   this.child.stdout!.on('data',b=>{if(!this.push(b))this.child!.stdout!.pause();});this.child.stdout!.on('end',()=>this.push(null));this.child.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.stdin!.on('error',()=>this.destroy(new Error('ISOLATED_STREAM_FAILED')));this.child.once('spawn',()=>this.emit('connect'));return this;
  }
  _read(){this.child?.stdout?.resume();}_write(b:any,e:any,cb:any){this.child!.stdin!.write(b,e,cb);}_final(cb:any){this.child!.stdin!.end(cb);}_destroy(e:Error|null,cb:(e:Error|null)=>void){this.child?.kill();cb(e);}
 }
 const local=createRequire(resolve('services/billing-service/package.json')),{Pool}=local('pg');
 pool=new Pool({host:'127.0.0.1',port:5432,database:'phase8_business_synthetic',user:'postgres',password:process.env.FACTUEZ_P8_TEST_PASSWORD,max:6,connectionTimeoutMillis:10000,stream:()=>new Stream()});
 // Reproduce only the existing FuelProduct model in the brand-new empty database.
 // No migration commands or application databases. The candidate never defines/changes this table.
 await pool.query(`CREATE TABLE "FuelProduct" (
  id uuid PRIMARY KEY,sku varchar(40) NOT NULL,description varchar(250) NOT NULL,category varchar(80) NOT NULL,
  "sunatProductCode" varchar(20),"unitCode" varchar(3) NOT NULL,"taxAffectationCode" varchar(2) NOT NULL,
  "defaultUnitPrice" numeric(18,6),active boolean NOT NULL DEFAULT true,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "FuelProduct_sku_key" UNIQUE (sku))`);
 await pool.query(readFileSync(resolve('services/billing-service/b2b-phase8-business.candidate.sql'),'utf8'));
},30000);
afterAll(async()=>{await pool?.end();});
const reset=async()=>{await pool.query('TRUNCATE "B2bP8Operation","B2bP8Movement","B2bP8Shift","B2bP8Customer","B2bP8ProductRevision","FuelProduct"');};
describe('phase8 real isolated PostgreSQL candidate owner cases',()=>{
 businessCases(async()=>{await reset();return new PostgresBusinessStore(pool);});
});
describe('phase8 PostgreSQL real catalogue and atomicity',()=>{
 beforeEach(reset);
 it('candidate defines only isolated sidecars and aggregates alongside FuelProduct',async()=>{
  const result=await pool.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename");
  expect(result.rows.map(r=>r.tablename)).toEqual(['B2bP8Customer','B2bP8Movement','B2bP8Operation','B2bP8ProductRevision','B2bP8Shift','FuelProduct']);
 });
 it('creates and updates actual FuelProduct without a parallel product source',async()=>{
  const h=harness(new PostgresBusinessStore(pool)),p=(await h.createProduct()).data as BusinessProduct;
  expect((await pool.query('SELECT sku,"defaultUnitPrice"::text AS price FROM "FuelProduct" WHERE id=$1',[p.id])).rows).toEqual([{sku:p.sku,price:'0.100001'}]);
  await h.execute('PRODUCTS_UPDATE',{id:p.id,expectedRevision:1,idempotencyKey:randomUUID(),body:{description:'CAMBIO REAL'}});
  expect((await pool.query('SELECT description FROM "FuelProduct" WHERE id=$1',[p.id])).rows[0].description).toBe('CAMBIO REAL');
  expect((await pool.query('SELECT revision FROM "B2bP8ProductRevision" WHERE product_id=$1',[p.id])).rows[0].revision).toBe(2);
 });
 it('reads legacy-created FuelProduct and detects external changes before CAS even with an unchanged timestamp',async()=>{
  const id=randomUUID(),h=harness(new PostgresBusinessStore(pool));
  await pool.query(`INSERT INTO "FuelProduct" (id,sku,description,category,"sunatProductCode","unitCode","taxAffectationCode","defaultUnitPrice","updatedAt")
   VALUES ($1,'existing legacy sku','PRODUCTO EXISTENTE','PRUEBA','12345678','NIU','10','0.123456',now())`,[id]);
  const before=(await h.execute('PRODUCTS_LIST')).data as BusinessProduct[];expect(before[0]).toMatchObject({id,revision:1,defaultUnitPrice:'0.123456'});
  await pool.query('UPDATE "FuelProduct" SET description=$2 WHERE id=$1',[id,'CAMBIO POS']);
  await expect(h.execute('PRODUCTS_UPDATE',{id,expectedRevision:1,idempotencyKey:randomUUID(),body:{active:false}})).rejects.toMatchObject({code:'REVISION_CONFLICT',status:412});
  const current=(await h.execute('PRODUCTS_LIST')).data as BusinessProduct[];expect(current[0]).toMatchObject({revision:2,description:'CAMBIO POS'});
  await h.execute('PRODUCTS_UPDATE',{id,expectedRevision:2,idempotencyKey:randomUUID(),body:{active:false}});
  expect((await pool.query('SELECT "sunatProductCode",active FROM "FuelProduct" WHERE id=$1',[id])).rows[0]).toEqual({sunatProductCode:'12345678',active:false});
 });
 it('audit insert failure rolls back actual FuelProduct sidecar and idempotency',async()=>{
  const h=harness(new PostgresBusinessStore(pool)),input={idempotencyKey:randomUUID(),body:product()};
  await pool.query(`CREATE FUNCTION p8_synthetic_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
   CREATE TRIGGER p8_synthetic_audit_failure BEFORE INSERT ON "B2bP8Operation" FOR EACH ROW EXECUTE FUNCTION p8_synthetic_audit_failure()`);
  try{await expect(h.createProduct(input)).rejects.toMatchObject({status:503});}
  finally{await pool.query('DROP TRIGGER p8_synthetic_audit_failure ON "B2bP8Operation"; DROP FUNCTION p8_synthetic_audit_failure()');}
  expect((await pool.query('SELECT count(*)::int AS n FROM "FuelProduct"')).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int AS n FROM "B2bP8ProductRevision"')).rows[0].n).toBe(0);
  expect((await h.createProduct(input)).replayed).toBe(false);
 });
 it('movement failure rolls back close audit and idempotency then allows retry',async()=>{
  const h=harness(new PostgresBusinessStore(pool)),s=(await h.open()).data as BusinessShift,input={id:s.id,expectedRevision:1,idempotencyKey:randomUUID(),countedAmount:'0.10',reason:'CIERRE'};
  await pool.query(`CREATE FUNCTION p8_synthetic_move_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic move failure'; END $$;
   CREATE TRIGGER p8_synthetic_move_failure BEFORE INSERT ON "B2bP8Movement" FOR EACH ROW EXECUTE FUNCTION p8_synthetic_move_failure()`);
  try{await expect(h.execute('SHIFTS_CLOSE',input)).rejects.toMatchObject({status:503});}
  finally{await pool.query('DROP TRIGGER p8_synthetic_move_failure ON "B2bP8Movement"; DROP FUNCTION p8_synthetic_move_failure()');}
  expect((await pool.query('SELECT state,revision FROM "B2bP8Shift" WHERE id=$1',[s.id])).rows[0]).toEqual({state:'OPEN',revision:1});
  expect((await h.execute('SHIFTS_CLOSE',input)).data).toMatchObject({state:'CLOSED',revision:2});
 });
 it('database refuses reopening or deleting closed shifts and changing movement/audit history',async()=>{
  const h=harness(new PostgresBusinessStore(pool)),s=(await h.open()).data as BusinessShift;
  await h.execute('SHIFTS_CLOSE',{id:s.id,expectedRevision:1,idempotencyKey:randomUUID(),countedAmount:'0.10',reason:'CIERRE'});
  await expect(pool.query('UPDATE "B2bP8Shift" SET state=\'OPEN\',revision=revision+1 WHERE id=$1',[s.id])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('DELETE FROM "B2bP8Shift" WHERE id=$1',[s.id])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('UPDATE "B2bP8Movement" SET amount=1 WHERE shift_id=$1',[s.id])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('DELETE FROM "B2bP8Operation"')).rejects.toMatchObject({code:'23514'});
 });
 it('committed shift revisions each have one movement and one attributable audit without bearer',async()=>{
  const h=harness(new PostgresBusinessStore(pool)),s=(await h.open()).data as BusinessShift;
  await h.execute('SHIFTS_CASH',{id:s.id,expectedRevision:1,idempotencyKey:randomUUID(),direction:'IN',amount:'0.20',reason:'ENTRADA'});
  const operations=(await pool.query('SELECT payload FROM "B2bP8Operation" ORDER BY payload->>\'afterRevision\'')).rows;
  expect(operations).toHaveLength(2);expect((await pool.query('SELECT revision FROM "B2bP8Movement" ORDER BY revision')).rows).toEqual([{revision:1},{revision:2}]);
  expect(operations.map(o=>o.payload.afterRevision)).toEqual([1,2]);for(const {payload} of operations){expect(payload.actor.clientId).toBe(h.principal.clientId);expect(payload.permissionRevision).toBe('1');expect(JSON.stringify(payload)).not.toContain('synthetic-token');}
 });
});
