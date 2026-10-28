import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CorporateDocumentStore } from '../services/mailer-worker/src/corporate-document-store';
import {readFileSync} from 'node:fs';
import { activeGrant, configurationDigest, digest } from '../services/mailer-worker/src/corporate-mail.policy';
import { SmtpConfigurationStore } from '../services/mailer-worker/src/smtp-configuration.store';
const { withPwaCorporateDatabase } = createRequire(import.meta.url)('./corporate-mail-runtime-db.fixture.cjs');
function prisma(pool: any) {
  const port = (connection: any) => ({
    $queryRaw: async (parts: TemplateStringsArray, ...values: any[]) => (await connection.query(parts.map((p, i) => p + (i < values.length ? '$' + (i + 1) : '')).join(''), values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: any[]) => (await connection.query(parts.map((p, i) => p + (i < values.length ? '$' + (i + 1) : '')).join(''), values)).rowCount,
  });
  return { ...port(pool), $transaction: async (action: (tx: any) => unknown) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5s'"); const result = await action(port(client)); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } };
}
beforeEach(() => { vi.stubEnv('MAILER_DATABASE_NAME', 'factuez_mailer_qa'); vi.stubEnv('DB_NAME', 'factuez_mailer_qa'); });
afterEach(() => vi.unstubAllEnvs());
describe('DOCUMENT persistence on a NEW isolated PostgreSQL database',()=>{
 it('preserves TEST isolation, exact idempotency, concurrent claims, revocation, expiry and encrypted payload cleanup',async()=>{
  await withPwaCorporateDatabase(async({pool,secondPool,sql}:any)=>{
   const ddl=readFileSync(new URL('../services/mailer-worker/prisma/corporate-document-runtime.deploy.sql',import.meta.url),'utf8');
   const marker='BEGIN;\nCREATE TABLE',index=ddl.indexOf(marker);expect(index).toBeGreaterThan(0);sql(ddl.slice(index));
   const a=prisma(pool),b=prisma(secondPool),store=new CorporateDocumentStore(a as never),other=new CorporateDocumentStore(b as never);
   const actor=randomUUID(),issuer={companyId:1,ruc:'00000000001'},documentId=randomUUID();
   const settings=new SmtpConfigurationStore(a as never),row=await settings.save(issuer,{cipher:'v1.1.QQ.QQ.QQ',keyVersion:1},0,actor,true);
   expect(await store.ready()).toBe(true);expect(await store.activation(issuer)).toBeNull();
   const grantRace=await Promise.allSettled([store.setActivation(row,actor,0,true),other.setActivation(row,actor,0,true)]);
   expect(grantRace.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(grantRace.filter(r=>r.status==='rejected')).toHaveLength(1);
   expect((await pool.query('SELECT count(*)::integer AS n FROM "CorporateSmtpActivation"')).rows[0].n).toBe(0);
   const input={row,actorId:actor,activationRevision:1,id:randomUUID(),idempotencyHash:digest(randomUUID()),requestHash:digest('exact-document-body'),payloadCipher:'encrypted-synthetic-only',documentId,format:'a4' as const,documentProof:digest('immutable-originals')};
   // Rehearse an already stored v1 01/03 grant: it must not gain notes silently.
   await pool.query('UPDATE "CorporateDocumentActivation" SET "configurationDigest"=$1 WHERE "issuerRuc"=$2',[configurationDigest(row),issuer.ruc]);
   await expect(store.enqueue(input)).rejects.toMatchObject({status:409});
   const renewed=await store.setActivation(row,actor,1,true);expect(renewed.revision).toBe(2);input.activationRevision=2;
   const jobs=await Promise.all([store.enqueue(input),other.enqueue({...input,id:randomUUID()})]);expect(jobs[0].id).toBe(jobs[1].id);
   await expect(store.enqueue({...input,requestHash:digest('changed')})).rejects.toMatchObject({status:409});
   const claims=await Promise.all([store.claim(jobs[0].id),other.claim(jobs[0].id)]);expect(claims.filter(Boolean)).toHaveLength(1);
   expect(await store.transition(jobs[0].id,'PREPARING','SENDING')).toBe(true);expect(await other.transition(jobs[0].id,'PREPARING','SENDING')).toBe(false);
   expect(await store.transition(jobs[0].id,'SENDING','HANDED_OFF')).toBe(true);
   expect(await store.get(jobs[0].id)).toMatchObject({state:'HANDED_OFF',payloadCipher:null});
   const history=await store.history(issuer,documentId);expect(history.jobs).toHaveLength(1);expect(JSON.stringify(history.events)).not.toMatch(/encrypted|recipient|Bearer|password|cipher/i);
   const next={...input,id:randomUUID(),idempotencyHash:digest(randomUUID()),requestHash:digest('second')};await store.enqueue(next);await store.claim(next.id);await store.transition(next.id,'PREPARING','SENDING');
   await pool.query('UPDATE "CorporateDocumentJob" SET "createdAt"=now()-interval \'3 minutes\',"expiresAt"=now()-interval \'1 minute\' WHERE id=$1::uuid',[next.id]);
   await store.expire();expect(await store.get(next.id)).toMatchObject({state:'UNKNOWN',payloadCipher:null});
   await store.setActivation(row,actor,2,false);
   await expect(store.enqueue({...input,id:randomUUID(),idempotencyHash:digest(randomUUID())})).rejects.toMatchObject({status:409});
   expect(await store.activation({companyId:2,ruc:issuer.ruc})).toBeNull();
   expect((await settings.read(issuer))?.revision).toBe(1);
  });
 });
});
