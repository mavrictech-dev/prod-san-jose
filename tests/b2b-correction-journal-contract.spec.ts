import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {b2bCandidateOpenApiV1} from '../packages/contracts/src/b2b-read-openapi';
import {CorrectionJournalRepository} from '../services/billing-service/src/application/correction-journal.repository';
import {projectCorrectionJournal} from '../packages/sunat-core/src/fiscal-correction-journal';
import {supplementCommandFixture} from './helpers/fiscal-supplement.fixture';
const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
describe('candidate enterprise correction journal contract',()=>{
  it('never accepts numbering, certificates, CDR, evidence flags or complete commands in the public input',()=>{
    const s=b2bCandidateOpenApiV1().components.schemas,create=s.EnterpriseCorrectionCreate;
    expect(create.additionalProperties).toBe(false);expect(Object.keys(create.properties)).toEqual(['schemaVersion','binding','originalDocumentId','idempotencyKey','externalReference','note','issueDate']);
    expect(s.CorrectionAdjustment.oneOf).toHaveLength(5);for(const variant of s.CorrectionAdjustment.oneOf)expect(variant.additionalProperties).toBe(false);
    expect(s.CorrectionBinding.properties.reference.properties.documentType.const).toBe('01');
  });
  it('documents real response data, including items, reference, reason and server-assigned number',()=>{
    const f=supplementCommandFixture(),projection=projectCorrectionJournal(f.doc,[{kind:'RESERVE',command:f.command,actorSha256:'a'.repeat(64)}]);
    const repo=new CorrectionJournalRepository({reserveWithinTransaction:async()=>{throw new Error('NOT_CALLED');}}),view=repo.view(projection,f.command.payload.operationId,false,f.command);
    const s=b2bCandidateOpenApiV1().components.schemas;
    expect(Object.keys(view).sort()).toEqual(Object.keys(s.EnterpriseCorrectionResult.properties).sort());
    expect(Object.keys(view.document).sort()).toEqual(Object.keys(s.EnterpriseCorrectionDocument.properties).sort());
    expect(view.document.items).toEqual(f.note.lines);expect(view.document.fullNumber).toBe(f.note.fullNumber);expect(view.originalDocumentId).toBe(f.doc.documentId);
    for(const [party,snapshot]of [[view.document.issuer,f.doc.issuer],[view.document.customer,f.doc.customer]]){
      expect(party).toEqual(snapshot);expect(Object.keys(party).every(k=>k in s.CorrectionSnapshotParty.properties)).toBe(true);
    }
    for(const item of view.document.items)expect(Object.keys(item).every(k=>k in s.CorrectionSnapshotItem.properties)).toBe(true);
    expect(view.fiscalExecutionEnabled).toBe(false);expect(view.transmissionAuthorized).toBe(false);expect(view).not.toHaveProperty('command');
  });
  it('documents full paired query and stronger owner permission requirements for status',()=>{
    const op=b2bCandidateOpenApiV1().paths['/b2b/v1/correction-notes/{id}'].get;
    expect(op.parameters.filter((p:any)=>p.in==='query').map((p:any)=>p.name).sort()).toEqual(['issuerId','issuerRuc','environment','branchId','pointId','seriesId','documentType','noteSeriesId','noteType'].sort());
    expect(op['x-required-scopes']).toEqual(expect.arrayContaining(['b2b:corrections:read','b2b:corrections:write','b2b:documents:read','b2b:documents:issue']));
    expect(op['x-runtime-enabled']).toBe(false);
  });
  it('retains immutable V1 and synthetic fences, and does not register an active producer',()=>{
    expect(read('services/billing-service/src/application/synthetic-correction-reservations.ts')).toContain('SYNTHETIC_DATABASE_REQUIRED');
    expect(read('services/billing-service/src/application/financial-ledger-candidate.repository.ts')).toContain('RESERVATIONS_IMMUTABLE');
    expect(read('services/billing-service/src/app.module.ts')).not.toContain('BillingCorrectionProducerModule');
    expect(read('infra/kong/kong.stage2.qa.yml')).not.toContain('/b2b/v1');
    expect(read('services/billing-service/src/b2b/correction-producer-assembly.ts')).toContain('createBillingCorrectionEvidencePorts');
    expect(read('services/billing-service/src/b2b/correction-producer-assembly.ts')).not.toMatch(/sunat-service\/|process\.env|assertOfficialFiscalActivation/);
  });
  it('DDL is additive, immutable and never changes counters, original data or published cursors',()=>{
    const sql=read('services/billing-service/b2b-correction-journal-v2.candidate.sql');
    expect(sql).toContain('UNIQUE ("operationId","kind")');expect(sql).toContain('CORRECTION_JOURNAL_APPEND_ONLY');expect(sql).toContain('CORRECTION_JOURNAL_HEAD_MONOTONIC');
    expect(sql).not.toMatch(/ALTER TABLE|DROP TABLE|TRUNCATE|UPDATE "SeriesCounter"|publishedAt|DELETE FROM/);
  });
});
