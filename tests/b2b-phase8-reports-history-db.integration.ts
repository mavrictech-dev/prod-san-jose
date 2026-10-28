import { createRequire } from 'node:module';
import { describe,it,expect } from 'vitest';
import { historicalSha256 } from '../packages/history-core/src';
import { HistoryArchiveRepository } from '../services/history-service/src/repository';
import { B2bHistoryReads,SyntheticB2bHistoryArchive } from '../services/history-service/src/b2b';
import { historyFixture } from './b2b-phase8-reports-history.fixture';
const req=createRequire(import.meta.url),{withPhase8ReportsDatabase}=req('./b2b-phase8-reports-db-helper.cjs');
const local=createRequire(new URL('../services/history-service/package.json',import.meta.url));
const {PrismaClient}=local('./dist/generated/prisma/client'),{PrismaPg}=local('@prisma/adapter-pg');
const legacyFixtures=req('./helpers/history-full-fixtures.cjs');
describe('B2B08 history backed by a NEW synthetic archive PostgreSQL',()=>{
  it('reads actual persisted archive with original role/marker guards and explicit enrollment only',async()=>{
    const f=historyFixture();let importer:any,reader:any;
    try {
      await withPhase8ReportsDatabase(async({createHistoryDatabase}:any)=>{
        const db=await createHistoryDatabase({markerId:f.markerId,mappings:f.input.mappings.map((m:any)=>({...m,mappingSha256:historicalSha256(m)}))});
        importer=new PrismaClient({adapter:new PrismaPg(db.importPool)});reader=new PrismaClient({adapter:new PrismaPg(db.readerPool)});
        const attestation={databaseName:db.databaseName,markerId:f.markerId},importRepository=new HistoryArchiveRepository(importer,attestation);
        const keys=await f.artifacts.stageBatch(f.input,0);await importRepository.commitBatch(f.input,0,legacyFixtures.actor(),keys);
        const repository=new HistoryArchiveRepository(reader,attestation,'READ_ONLY'),archive=new SyntheticB2bHistoryArchive(repository,f.artifacts,f.permission);
        const core=new B2bHistoryReads(f.identity,archive,{enabled:true,environment:'BETA',datasetClass:'SYNTHETIC'});
        expect((await core.execute(f.auth,'LIST',{binding:f.binding})).data.items).toHaveLength(1);
        const detail=await core.execute(f.auth,'DETAIL',{binding:f.binding,recordId:f.recordId});expect(detail.data.snapshotSha256).toBe(f.plan.records[0].snapshotSha256);expect(detail.data.artifactKeys).toBeUndefined();
        const file=await core.execute(f.auth,'CONTENT',{binding:f.binding,recordId:f.recordId,artifactKind:'SIGNED_XML'});expect(file.bytes.toString()).toContain('SIN FIRMA');
        expect(file.sha256).toBe(f.row.snapshot.artifacts.find((a:any)=>a.kind==='SIGNED_XML').sha256);
        await expect(db.readerPool.query('DELETE FROM "HistoryRecord"')).rejects.toMatchObject({code:'42501'});
        await expect(db.adminPool.query('UPDATE "HistoryRecord" SET "candidateOnly"=false')).rejects.toThrow(/HISTORY_IMMUTABLE/);
        f.unenroll();await expect(core.execute(f.auth,'DETAIL',{binding:f.binding,recordId:f.recordId})).rejects.toMatchObject({code:'HISTORY_ARCHIVE_NOT_ENROLLED'});
        const broken=new HistoryArchiveRepository(reader,{databaseName:db.databaseName,markerId:'00000000-0000-4000-8000-000000000099'},'READ_ONLY');
        const bad=new B2bHistoryReads(f.identity,new SyntheticB2bHistoryArchive(broken,f.artifacts,f.permission),{enabled:true,environment:'BETA',datasetClass:'SYNTHETIC'});
        f.permission.authorizeCurrent.mockResolvedValue(structuredClone(f.decision));await expect(bad.execute(f.auth,'DETAIL',{binding:f.binding,recordId:f.recordId})).rejects.toThrow(/SANDBOX_MARKER_MISMATCH/);
        await importer.$disconnect();await reader.$disconnect();importer=null;reader=null;
      });
    }finally{await importer?.$disconnect();await reader?.$disconnect();f.close();}
  });
});