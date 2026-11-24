import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {DEFAULT_TAX_POLICY,canonicalCatalogName} from '../packages/contracts/src/catalog-tax';
import {calculateDocumentTotals} from '../packages/sunat-core/src/tax';
import {validateFiscalSnapshot} from '../packages/sunat-core/src/fiscal-rules';
import {buildInvoiceUbl} from '../packages/sunat-core/src/ubl';
import {CatalogTaxService,validateTaxPolicy} from '../services/billing-service/src/application/catalog-tax.service';
import {ProductAdminService} from '../services/billing-service/src/application/product-admin.service';
import {IssueDocumentService} from '../services/billing-service/src/application/issue-document.service';
import {StationAdminService} from '../services/billing-service/src/application/station-admin.service';
const local=createRequire(import.meta.url),{withNativePostgres}=local('./helpers/native-postgres.cjs'),{update}=local('../scripts/update-igv-catalogs-gre.cjs');
export function mixedSnapshot(){return {documentId:randomUUID(),companyId:1,branchId:randomUUID(),environment:'PRODUCTION' as const,documentTypeCode:'01' as const,series:'F001',number:'1',fullNumber:'F001-1',issueDate:'2026-11-23T10:00:00-05:00',currencyCode:'PEN' as const,operationTypeCode:'0101',paymentTerms:{type:'CONTADO' as const},issuer:{identityType:'6',identityNumber:'20100070970',legalName:'SYNTHETIC ISSUER',address:'SYNTHETIC ADDRESS',ubigeo:'150101',establishmentCode:'0000'},customer:{identityType:'6',identityNumber:'20131312955',legalName:'SYNTHETIC CUSTOMER'},...calculateDocumentTotals([['10','18','118'],['20','0','50'],['30','0','25']].map(([taxAffectationCode,igvRate,unitPriceWithTax])=>({description:'SYNTHETIC',quantity:'1',unitPriceWithTax,unitCode:'NIU',taxAffectationCode,igvRate})))};}
describe('exact tax buckets and profiles',()=>{
 it('keeps18 percent distinct from affectation, and makes Selva conditional',()=>{expect(canonicalCatalogName('  Combustible   LIQUIDO ')).toBe('combustible liquido');expect(validateTaxPolicy(DEFAULT_TAX_POLICY).rate).toBe('18.00');expect(()=>validateTaxPolicy({...DEFAULT_TAX_POLICY,region:'SELVA',defaultTreatment:'20'})).toThrow();expect(()=>calculateDocumentTotals([{description:'X',unitCode:'NIU',quantity:'1',unitPriceWithTax:'100',taxAffectationCode:'18',igvRate:'18'}])).toThrow();});
 it('balances mixed real-RUC XML with distinct tax schemes and never calls exempt base taxable',()=>{const s=mixedSnapshot();expect(s.totals).toEqual({taxableAmount:'100.00',exemptAmount:'50.00',unaffectedAmount:'25.00',igvAmount:'18.00',payableAmount:'193.00'});expect(validateFiscalSnapshot(s,{mode:'REAL_PREPARATION'}).issues).toEqual([]);const xml=buildInvoiceUbl(s,{mode:'REAL_PREPARATION'});expect(xml).toContain('9997');expect(xml).toContain('9998');expect(xml).toContain('>175.00</cbc:LineExtensionAmount>');expect(validateFiscalSnapshot({...s,totals:{...s.totals,taxableAmount:'175.00'}},{mode:'REAL_PREPARATION'}).valid).toBe(false);expect(validateFiscalSnapshot({...s,lines:s.lines.map((l,i)=>i?l:{...l,igvRate:'16'})},{mode:'REAL_PREPARATION'}).valid).toBe(false);});
});
describe.skipIf(!process.env.NATIVE_TEST_POSTGRES_BIN)('additive existing-install migration and RUC/site persistence on NEW PostgreSQL',()=>{
 it('deduplicates/backfills canonical IDs, preserves history, enforces CAS and scopes, and persists after client restart',async()=>withNativePostgres(async({pool,local:serviceRequire,root}:any)=>{
  const service=join(root,'services/billing-service'),old=spawnSync('git',['show','bbe4c93228435af311696b9d622dbfe6e553e032:services/billing-service/prisma/schema.prisma'],{cwd:root,encoding:'utf8'});expect(old.status).toBe(0);mkdirSync(join(root,'.qa'),{recursive:true});const schema=join(root,'.qa','legacy-billing.prisma');writeFileSync(schema,old.stdout);
  const ddl=spawnSync(process.execPath,[join(service,'node_modules/prisma/build/index.js'),'migrate','diff','--from-empty','--to-schema',schema,'--script'],{cwd:service,encoding:'utf8',windowsHide:true,env:{...process.env,DATABASE_URL:'postgresql://build:build@127.0.0.1:1/not_connected'}});expect(ddl.status,ddl.stderr).toBe(0);await pool.query(ddl.stdout);
  const branch1=randomUUID(),branch2=randomUUID(),branchOther=randomUUID(),point=randomUUID(),counter=randomUUID(),p1=randomUUID(),p2=randomUUID(),p3=randomUUID(),document=randomUUID(),actorId=randomUUID();
  await pool.query(`INSERT INTO "CompanySettings" (id,ruc,"legalName","companyType","economicActivities","taxAddress",ubigeo,"contactEmails","updatedAt") VALUES (1,'00100000001','SYNTHETIC ONE','SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],now()),(2,'00100000002','SYNTHETIC TWO','SYNTHETIC',ARRAY[]::text[],'SYNTHETIC','150101',ARRAY[]::text[],now())`);
  for(const [id,companyId] of [[branch1,1],[branch2,1],[branchOther,2]])await pool.query('INSERT INTO "Branch" (id,"companyId",code,name,"establishmentCode") VALUES ($1,$2,$3,$3,\'0000\')',[id,companyId,String(id).slice(0,8)]);
  await pool.query('INSERT INTO "EmissionPoint" (id,"companyId","branchId",code,name,"updatedAt") VALUES ($1,1,$2,\'SYNTHETIC\',\'SYNTHETIC\',now())',[point,branch1]);
  await pool.query('INSERT INTO "SeriesCounter" (id,"companyId","emissionPointId","documentType",series,"nextNumber","updatedAt") VALUES ($1,1,$2,\'INVOICE\',\'F001\',8,now())',[counter,point]);
  for(const [id,category,unit] of [[p1,' Combustible   Liquido ','NIU'],[p2,'COMBUSTIBLE LIQUIDO','NIU'],[p3,'Otra','XYZ']])await pool.query('INSERT INTO "FuelProduct" (id,sku,description,category,"unitCode","taxAffectationCode","updatedAt") VALUES ($1,$4,\'SYNTHETIC\',$2,$3,\'10\',now())',[id,category,unit,id]);
  const frozen={environment:'BETA',value:'IMMUTABLE_SYNTHETIC_HISTORY'};await pool.query(`INSERT INTO "Document" (id,"companyId","seriesCounterId",type,series,number,"fullNumber","issueDate","emissionPointId","createdByUserId","customerIdentityType","customerIdentityNumber","customerLegalName","taxableAmount","igvAmount","payableAmount","immutableSnapshot","updatedAt") VALUES ($1,1,$2,'INVOICE','F001',7,'F001-7',now(),$3,$4,'6','00100000002','SYNTHETIC',100,18,118,$5::jsonb,now())`,[document,counter,point,actorId,JSON.stringify(frozen)]);
  expect((await update(pool,{root,service:'billing-service',apply:false})).pending).toHaveLength(4);await update(pool,{root,service:'billing-service',apply:true});expect((await update(pool,{root,service:'billing-service',apply:false})).pending).toEqual([]);await update(pool,{root,service:'billing-service',apply:true});
  // Existing native tables are adopted only after a structural comparison with the reviewed DDL.
  await pool.query('DELETE FROM "FactuezSchemaUpdate" WHERE id=\'20261123_native_gre_billing_v1\'');await update(pool,{root,service:'billing-service',apply:true});
  await pool.query('ALTER TABLE "ProductionGuidesOwnerStatus" ADD COLUMN unexpected boolean');await pool.query('DELETE FROM "FactuezSchemaUpdate" WHERE id=\'20261123_native_gre_billing_v1\'');await expect(update(pool,{root,service:'billing-service',apply:true})).rejects.toThrow('GRE_SCHEMA_INCOMPATIBLE');expect((await pool.query('SELECT count(*)::int AS n FROM "FactuezSchemaUpdate" WHERE id=\'20261123_native_gre_billing_v1\'')).rows[0].n).toBe(0);await pool.query('ALTER TABLE "ProductionGuidesOwnerStatus" DROP COLUMN unexpected');
  await Promise.all([update(pool,{root,service:'billing-service',apply:true}),update(pool,{root,service:'billing-service',apply:true})]);expect((await update(pool,{root,service:'billing-service',apply:false})).pending).toEqual([]);
  const products=(await pool.query('SELECT id,sku,"categoryId" FROM "FuelProduct" ORDER BY id')).rows;expect(products).toHaveLength(3);expect(new Set(products.filter((r:any)=>[p1,p2].includes(r.id)).map((r:any)=>r.categoryId)).size).toBe(1);expect((await pool.query('SELECT active FROM "ProductUnit" WHERE code=\'XYZ\'')).rows[0].active).toBe(false);
  await expect(pool.query('INSERT INTO "ProductCategory" (name,"normalizedKey") VALUES (\' combustible liquido \',\'caller-forgery\')')).rejects.toThrow();
  const {PrismaClient}=serviceRequire('./dist/generated/prisma/client'),{PrismaPg}=serviceRequire('@prisma/adapter-pg');let client=new PrismaClient({adapter:new PrismaPg(pool)});
  const request={headers:{},user:{sub:actorId,scope:{kind:'GLOBAL'},roles:['ADMIN'],permissions:['setup.manage','product.manage','document.issue','document.view']}} as any;
  let tax=new CatalogTaxService(client);const selva={...DEFAULT_TAX_POLICY,region:'SELVA' as const,allowExempt:true,allowUnaffected:true};
  await tax.save(1,null,{expectedRevision:0,overridden:true,policy:selva},request);await expect(tax.save(1,null,{expectedRevision:0,overridden:true,policy:selva},request)).rejects.toThrow();
  expect((await tax.view(2,branchOther,request)).policy.allowExempt).toBe(false);expect((await tax.view(1,branch1,request)).source).toBe('RUC');
  await tax.save(1,branch1,{expectedRevision:0,overridden:true,policy:{...selva,region:'SIERRA'}},request);expect((await tax.view(1,branch2,request)).policy.region).toBe('SELVA');
  await tax.saveProductTax(1,branch1,p1,{expectedRevision:0,overridden:true,treatment:'20'},request);const effective=await tax.effectiveProducts(1,branch1,request);expect(effective.products.find(p=>p.id===p1)?.igvRate).toBe('0');expect((await tax.effectiveProducts(2,branchOther,request)).products.find(p=>p.id===p1)?.taxAffectationCode).toBe('10');
  const scoped={...request,user:{...request.user,scope:{kind:'ASSIGNED',branchIds:[branch1],emissionPointIds:[],series:[]}}};await expect(tax.save(1,branch2,{expectedRevision:0,overridden:true,policy:selva},scoped)).rejects.toThrow();await expect(tax.view(2,branchOther,scoped)).rejects.toThrow();
  const category=effective.products.find(p=>p.id===p1)!.categoryId;const admin=new ProductAdminService(client);await expect(admin.save(undefined,{sku:'BAD',description:'SYNTHETIC',categoryId:category,unitCode:'NIU',taxAffectationCode:'18'},request)).rejects.toThrow();await expect(admin.save(undefined,{sku:'BAD',description:'SYNTHETIC',categoryId:category,unitCode:'ABC',taxAffectationCode:'10'},request)).rejects.toThrow();
  const names=await Promise.allSettled([' Nueva categoría ','NUEVA CATEGORÍA'].map(name=>tax.saveMaster('categories',undefined,{name},request)));expect(names.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const issuer=new IssueDocumentService(client,undefined,tax),ctx={userId:actorId,idempotencyKey:randomUUID(),correlationId:randomUUID(),scope:{kind:'GLOBAL' as const}};
  const input={emissionPointId:point,documentType:'INVOICE' as const,series:'F001',customer:{identityType:'6',identityNumber:'00100000002',legalName:'SYNTHETIC CUSTOMER'},paymentTerms:{type:'CONTADO' as const},lines:[{productId:p1,description:'SYNTHETIC EXEMPT',unitCode:'NIU',quantity:'1',unitPriceWithTax:'50',taxAffectationCode:'20',igvRate:'0'},{productId:p2,description:'SYNTHETIC TAXABLE',unitCode:'NIU',quantity:'1',unitPriceWithTax:'118',taxAffectationCode:'10',igvRate:'18'}]};
  const emitted=await issuer.execute(input,ctx);expect(emitted.taxableAmount.toString()).toBe('100');expect(emitted.exemptAmount.toString()).toBe('50');expect(emitted.igvAmount.toString()).toBe('18');expect(emitted.payableAmount.toString()).toBe('168');expect((emitted.immutableSnapshot as any).taxPolicy).toMatchObject({companyId:1,branchId:branch1,rucRevision:1,branchRevision:1});expect(await issuer.execute(input,ctx)).toMatchObject({id:emitted.id});
  const schemes=await client.documentTax.findMany({where:{documentId:emitted.id}});expect(schemes.map((r:any)=>r.taxSchemeId).sort()).toEqual(['1000','9997']);
  const before=JSON.stringify((await pool.query('SELECT "immutableSnapshot" FROM "Document" WHERE id=$1',[document])).rows[0]);expect(before).toContain('IMMUTABLE_SYNTHETIC_HISTORY');expect((await pool.query('SELECT "nextNumber" FROM "SeriesCounter" WHERE id=$1',[counter])).rows[0].nextNumber).toBe('9');
  // New owner instance simulates process restart; no in-memory policy cache is used.
  tax=new CatalogTaxService(client);expect((await tax.view(1,branch1,request)).policy.region).toBe('SIERRA');await tax.save(1,branch1,{expectedRevision:1,overridden:false},request);expect((await tax.view(1,branch1,request)).source).toBe('RUC');expect(JSON.stringify((await pool.query('SELECT "immutableSnapshot" FROM "Document" WHERE id=$1',[document])).rows[0])).toBe(before);
  await tax.saveMaster('categories',category,{name:'Combustible homologado',expectedRevision:1},request);
  expect((await admin.list(request)).find(p=>p.id===p1)?.category).toBe('Combustible homologado');
  expect((await client.fuelProduct.findUnique({where:{id:p2}}))?.category).toBe('Combustible homologado');
  expect(JSON.stringify((await pool.query('SELECT "immutableSnapshot" FROM "Document" WHERE id=$1',[document])).rows[0])).toBe(before);
  // Real owner transaction: move a used Beta issuer to fresh production series,
  // while its Beta originals, pending work and consumed counters stay untouched.
  vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED','true');vi.stubEnv('STATION_MASTER_CRUD_ENABLED','true');
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ruc:'00100000001',environment:'PRODUCTION',enabled:true})));
  try{
    const stations=new StationAdminService(client),productionRequest={...request,headers:{authorization:'Bearer SYNTHETIC.AUTH'},user:{...request.user,permissions:[...request.user.permissions,'sunat.configure','series.manage']}};
    const command={expectedRevision:1,environment:'PRODUCTION',confirmation:'CAMBIAR EMISOR A PRODUCCIÓN'};
    await expect(stations.configureEnvironment('1',{...command,productionSeries:[]},productionRequest)).rejects.toThrow('historial Beta');
    const moved=await stations.configureEnvironment('1',{...command,productionSeries:[{pointId:point,documentType:'INVOICE',series:'F002'}]},productionRequest);
    expect(moved.environment).toBe('PRODUCTION');
    expect(await client.seriesCounter.findUnique({where:{id:counter}})).toMatchObject({environment:'BETA',active:false,nextNumber:9n});
    const newCounter=await client.seriesCounter.findFirst({where:{companyId:1,series:'F002'}});expect(newCounter).toMatchObject({environment:'PRODUCTION',active:true,nextNumber:1n});
    const extra=await stations.createSeries(point,{documentType:'INVOICE',series:'F003'},productionRequest);
    expect(await client.seriesCounter.findUnique({where:{id:extra.id}})).toMatchObject({environment:'PRODUCTION',nextNumber:1n});
    expect(JSON.stringify((await pool.query('SELECT "immutableSnapshot" FROM "Document" WHERE id=$1',[document])).rows[0])).toBe(before);
    expect((await client.outboxEvent.findMany()).every(e=>(e.payload as any).payload?.environment!=='PRODUCTION')).toBe(true);
  }finally{vi.unstubAllEnvs();vi.unstubAllGlobals();}
  await client.$disconnect();
 }),120000);
});
