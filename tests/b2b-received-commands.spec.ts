import {describe,it,expect} from 'vitest';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';
import {fixture,scope,access,file,id} from './helpers/b2b-received-commands.fixture';
import {PostgresReceptionWriteAuthority} from '../services/received-documents-service/src/b2b/write-authority';
import {receivedXml} from './received-fixture.mjs';
const key='synthetic_unit_0001';
function neverDb(){let calls=0;return {get calls(){return calls;},$transaction:async()=>{calls++;throw new Error('SYNTHETIC_PRIVATE_SQL');}};}
describe('received commands bounded request admission and finite failures',()=>{
 it.each([null,[],{}, {scope,key,payload:{},extra:true}])('rejects malformed envelope %# before SQL',async input=>{
  const db=neverDb(),f=fixture(db);await expect(f.owner.execute(access,'IMPORT',input)).rejects.toMatchObject({status:400,code:'INVALID_RECEIVED_REQUEST'});expect(db.calls).toBe(0);
 });
 it.each([file(Buffer.alloc(65537)),{fileName:'bad.xml',contentBase64:'YWJ='},file('x','../original.xml'),file('x','bad\u202e.xml')])('rejects oversized/noncanonical/path/control uploads %# before Identity',async payload=>{
  const db=neverDb(),f=fixture(db);await expect(f.owner.execute(access,'IMPORT',{scope,key,payload})).rejects.toBeInstanceOf(B2bSecurityError);expect(db.calls).toBe(0);expect(f.control.identityCalls).toBe(0);
 });
 it('rejects accessors without invoking them',async()=>{
  let ran=false;const input={scope,key,get payload(){ran=true;return file('x');}};
  const f=fixture(neverDb());await expect(f.owner.execute(access,'IMPORT',input)).rejects.toMatchObject({status:400});expect(ran).toBe(false);
 });
 it('does not derive WRITE from a valid READ-only principal',async()=>{
  const db=neverDb(),f=fixture(db);f.principal.scopes=['b2b:received:read'];
  await expect(f.owner.execute(access,'IMPORT',{scope,key,payload:file(receivedXml())})).rejects.toMatchObject({status:403});expect(db.calls).toBe(0);
 });
 it('fails closed with finite error on authority SQL failure',async()=>{
  const db=neverDb(),f=fixture(db);const e=await f.owner.execute(access,'IMPORT',{scope,key,payload:file(receivedXml())}).catch(e=>e);
  expect(e).toBeInstanceOf(B2bSecurityError);expect(e).toMatchObject({status:503,code:'RECEIVED_OWNER_UNAVAILABLE'});expect(String(e)).not.toContain('PRIVATE_SQL');
 });
 it('requires configured opaque administrator; never accepts a caller approval flag',async()=>{
  const db=neverDb(),f=fixture(db);await expect(new PostgresReceptionWriteAuthority(db).setGrant('synthetic-live-step-up',f.policy('IMPORT'),0)).rejects.toMatchObject({status:503});
  await expect(f.authority.setGrant('synthetic-live-step-up',{...f.policy('IMPORT'),approved:true},0)).rejects.toMatchObject({status:400});expect(db.calls).toBe(0);
 });
 it.each([
  (v:any)=>({...v,subject:{...v.subject,subjectId:id(8)}}),
  (v:any)=>({...v,userAuthRevision:1}),
  (v:any)=>({...v,subject:{...v.subject,kind:'USER',subjectId:id(8)},userAuthRevision:null}),
  (v:any)=>({...v,clientRevision:'1'}),
  (v:any)=>({...v,action:'READ'}),
 ])('validates subject/revisions and action before SQL %#',async mutate=>{
  const db=neverDb(),f=fixture(db);await expect(f.authority.setGrant('synthetic-live-step-up',mutate(f.policy('IMPORT')),0)).rejects.toMatchObject({status:400});expect(db.calls).toBe(0);
 });
});
