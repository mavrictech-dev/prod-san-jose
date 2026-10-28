import { describe, expect, it, vi } from 'vitest';
import { PgTransaction } from '../services/identity-service/src/b2b/postgres-store';
import { adminFixture,ctx,input,id } from './b2b-integration-admin.fixture';
describe('candidate application SQL boundaries',()=>{
  it('selects bounded keyset metadata with BETA and no stored credentials or offset',async()=>{
    const db:any={$queryRawUnsafe:vi.fn(async()=>[]),$executeRawUnsafe:vi.fn(async()=>1)},tx=new PgTransaction(db);
    await tx.list({environment:'BETA',limit:7,after:id(4)});
    const [sql,...params]=db.$queryRawUnsafe.mock.calls[0];expect(sql).toContain('"environment"=\'BETA\'');expect(sql).toContain('ORDER BY "id" ASC LIMIT $2');expect(sql).not.toMatch(/secretHash|password|OFFSET/);expect(params).toEqual([id(4),8]);
    await tx.list({environment:'BETA',limit:50});expect(db.$queryRawUnsafe.mock.calls[1].slice(1)).toEqual([null,51]);
    await expect(tx.list({environment:'PRODUCTION',limit:1} as any)).rejects.toMatchObject({status:400});expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
  it('binds labels separately and retains BETA/optimistic revision in SQL updates',async()=>{
    const f=adminFixture(),made=await f.core.create('human-step-up',input(),ctx()),row=f.store.clients.get(made.client.id)!;
    const db:any={$queryRawUnsafe:vi.fn(),$executeRawUnsafe:vi.fn(async()=>1)},tx=new PgTransaction(db),label='label with SQL-like punctuation ";';
    await tx.save({...row,label,revision:2},1);const [sql,...values]=db.$executeRawUnsafe.mock.calls[0];expect(sql).not.toContain(label);expect(sql).toContain('"label"=$8');expect(sql).toContain('"revision"=$7');expect(sql).toContain('"environment"=\'BETA\'');expect(values.at(-1)).toBe(label);
    db.$executeRawUnsafe.mockResolvedValue(0);await expect(tx.save({...row,label},1)).rejects.toMatchObject({status:409});
  });
});
