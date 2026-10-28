import {describe,it,expect} from 'vitest';import {randomUUID,randomBytes} from 'node:crypto';
import {sealB2bSyntheticRecovery,openB2bSyntheticRecovery,b2bRecoveryInventorySha} from '../infra/b2b/recovery-bundle.mjs';
const owner=(name='BILLING',profile='B2B_REPORTS_V1')=>({owner:name,profile,schemaSha256:'a'.repeat(64),tables:[{name:'B2bP8ReportJob',count:1,sha256:'b'.repeat(64)}],sequences:[],databaseDump:Buffer.from('PGDMP SYNTHETIC_NOT_A_REAL_DUMP'),originals:[{name:'original.xml',mediaType:'application/xml',bytes:Buffer.from('<SyntheticOriginal/>')}]});
const sample=()=>({runId:randomUUID(),backupId:randomUUID(),keyVersion:1,environment:'BETA',datasetClass:'SYNTHETIC',capturedAt:new Date().toISOString(),consistency:'QUIESCED_ISOLATED_REHEARSAL',owners:[owner(),owner('RECEIVED','B2B_RECEPTION_COMMANDS_V1'),owner('MAILER','B2B_CORPORATE_EMAIL_V1')]});
const context=(v:any)=>({runId:v.runId,backupId:v.backupId,keyVersion:v.keyVersion,owners:v.owners.map((o:any)=>o.owner)});
describe('B2B-09 authenticated multi-owner rehearsal capsule, no restore side effects',()=>{
 it('round-trips exact dumps/originals without cleartext, a key in metadata or source mutation',()=>{
  const v=sample(),key=randomBytes(32),sealed=sealB2bSyntheticRecovery(v,key),before=Buffer.from(sealed),opened=openB2bSyntheticRecovery(sealed,key,context(v));
  expect(sealed.includes(Buffer.from('SyntheticOriginal'))).toBe(false);expect(sealed.includes(key)).toBe(false);expect(opened.owners).toHaveLength(3);
  for(const o of v.owners){const recovered=opened.owners.find((x:any)=>x.owner===o.owner);expect(recovered.databaseDump).toEqual(o.databaseDump);expect(recovered.originals[0].bytes).toEqual(o.originals[0].bytes);}
  expect(sealed).toEqual(before);expect(opened).not.toHaveProperty('key');
 });
 it.each([0,7,8,19,20,35,36,80])('rejects tampering at byte %i before a restore callback could run',offset=>{
  const v=sample(),key=randomBytes(32),sealed=sealB2bSyntheticRecovery(v,key);sealed[offset]^=1;expect(()=>openB2bSyntheticRecovery(sealed,key,context(v))).toThrow('B2B_SYNTHETIC_RECOVERY_INVALID');
 });
 it('binds the complete owner set, run, backup and key version; wrong key cannot read it',()=>{
  const v=sample(),key=randomBytes(32),sealed=sealB2bSyntheticRecovery(v,key),c=context(v);
  for(const expected of [{...c,runId:randomUUID()},{...c,backupId:randomUUID()},{...c,keyVersion:2},{...c,owners:['BILLING']},{...c,owners:['BILLING','RECEIVED','SUNAT']}])expect(()=>openB2bSyntheticRecovery(sealed,key,expected)).toThrow();
  expect(()=>openB2bSyntheticRecovery(sealed,randomBytes(32),c)).toThrow();expect(openB2bSyntheticRecovery(sealed,key,c).backupId).toBe(v.backupId);
 });
 it.each(['PRODUCTION','TEST',null])('rejects environment %s',environment=>expect(()=>sealB2bSyntheticRecovery({...sample(),environment},randomBytes(32))).toThrow());
 it.each(['AUTHORIZED_COPY','LIVE',null])('does not enable real backup through a mode edit %s',datasetClass=>expect(()=>sealB2bSyntheticRecovery({...sample(),datasetClass},randomBytes(32))).toThrow());
 it('rejects omitted, duplicate or relabelled owners/profiles',()=>{
  for(const owners of [[],[owner(),owner()],[owner('SUNAT')],[owner('BILLING','FULL_COMPANY_BACKUP')]])expect(()=>sealB2bSyntheticRecovery({...sample(),owners},randomBytes(32))).toThrow();
 });
 it.each(['../secret.xml','C:/cert.p12','/etc/a.xml','cert.p12','UPPER.xml','a.pdf\n'])('rejects unsafe file name %s',name=>{
  const v=sample();v.owners[0].originals[0].name=name;expect(()=>sealB2bSyntheticRecovery(v,randomBytes(32))).toThrow();
 });
 it('requires matching media, unique names, PG custom dump and bounded bytes',()=>{
  const key=randomBytes(32);let v=sample();v.owners[0].originals[0].mediaType='application/pdf';expect(()=>sealB2bSyntheticRecovery(v,key)).toThrow();
  v=sample();v.owners[0].originals.push(v.owners[0].originals[0]);expect(()=>sealB2bSyntheticRecovery(v,key)).toThrow();
  v=sample();v.owners[0].databaseDump=Buffer.from('plain sql');expect(()=>sealB2bSyntheticRecovery(v,key)).toThrow();
  v=sample();v.owners[0].databaseDump=Buffer.alloc(16*1024**2+1);expect(()=>sealB2bSyntheticRecovery(v,key)).toThrow();
 });
 it('inventory preserves sequence values/called flags, sorts deterministically and rejects duplicate tables',()=>{
  const base=owner(),{databaseDump,originals,...meta}=base;meta.sequences=[{name:'Audit_id_seq',lastValue:'9007199254740993',isCalled:true}] as any;
  const sha=b2bRecoveryInventorySha(meta);expect(sha).toMatch(/^[a-f0-9]{64}$/);expect(b2bRecoveryInventorySha({...meta,sequences:[{...meta.sequences[0],isCalled:false}]})).not.toBe(sha);
  expect(()=>b2bRecoveryInventorySha({...meta,tables:[...meta.tables,...meta.tables]})).toThrow();expect(()=>b2bRecoveryInventorySha({...meta,sequences:[{...meta.sequences[0],lastValue:'9223372036854775808'}]})).toThrow();
 });
 it('does not invoke proxies, accessors, toJSON or iterators supplied as data',()=>{
  let calls=0;const key=randomBytes(32),v=sample(),malicious=[new Proxy(v,{get(){calls++;throw Error('PRIVATE');}}),{...v,toJSON(){calls++;}},Object.defineProperty({...v},'owners',{enumerable:true,get(){calls++;throw Error('PRIVATE');}})];
  for(const input of malicious)expect(()=>sealB2bSyntheticRecovery(input,key)).toThrow('B2B_SYNTHETIC_RECOVERY_INVALID');
  const a=sample();(a.owners as any)[Symbol.iterator]=()=>{calls++;throw Error('PRIVATE');};expect(()=>sealB2bSyntheticRecovery(a,key)).toThrow();expect(calls).toBe(0);
  const b=sample();(b as any).runId={toString(){calls++;throw Error('PRIVATE');}};expect(()=>sealB2bSyntheticRecovery(b,key)).toThrow();expect(calls).toBe(0);
 });
 it('rejects extra metadata and makes no destination decision from backup content',()=>{
  expect(()=>sealB2bSyntheticRecovery({...sample(),destination:'D:/PRIVATE'},randomBytes(32))).toThrow();
  const v=sample(),key=randomBytes(32),sealed=sealB2bSyntheticRecovery(v,key);expect(()=>openB2bSyntheticRecovery(sealed,key,{...context(v),destination:'PRIVATE'})).toThrow();
 });
});
