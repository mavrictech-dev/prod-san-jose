import { createRequire } from 'node:module';
import { describe,it,expect,vi } from 'vitest';
import { verifyProductionBatchesCdr } from '../services/sunat-service/src/infrastructure/production-batches-cdr';
import { productionBatchesZipMembers } from '../services/sunat-service/src/infrastructure/production-batches-zip';
import { batch } from './production-batches-fixture';
const {zipSync}=createRequire(new URL('../services/sunat-service/package.json',import.meta.url))('fflate');
const b=batch(),prefix='R-'+b.issuerRuc+'-';
const xml=(ref:string,code='0',receiver=b.issuerRuc)=>Buffer.from('<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cac:SenderParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification></cac:SenderParty><cac:ReceiverParty><cac:PartyIdentification><cbc:ID>'+receiver+'</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:Response><cbc:ReferenceID>'+ref+'</cbc:ReferenceID><cbc:ResponseCode>'+code+'</cbc:ResponseCode></cac:Response><cac:DocumentReference><cbc:ID>'+ref+'</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>');
const zip=(files:Record<string,Buffer>)=>Buffer.from(zipSync(files,{level:0}));
const summary=()=>({[prefix+b.identifier+'.xml']:xml(b.identifier)});
const full=()=>({...summary(),...Object.fromEntries(b.entries.map(e=>[prefix+'03-'+e.snapshot.fullNumber+'.xml',xml(e.snapshot.fullNumber)]))});
describe('exact production batch CDR archive (test-only trust port)',()=>{
 it('verifies exact summary-only or every-member archives',async()=>{
  for(const files of [summary(),full()]){
   const trust={verify:vi.fn(async()=>true)},result=await verifyProductionBatchesCdr(zip(files),b,trust);
   expect(result.status).toBe('ACCEPTED');expect(trust.verify).toHaveBeenCalledTimes(Object.keys(files).length);
  }
 });
 it('refuses partial membership, extra members, wrong reference and receiver',async()=>{
  const trust={verify:vi.fn(async()=>true)};
  const partial=full();delete partial[prefix+'03-'+b.entries[0].snapshot.fullNumber+'.xml'];
  for(const files of [partial,{...full(),'R-extra.xml':xml('extra')},{[prefix+b.identifier+'.xml']:xml('RC-20261028-9')},{[prefix+b.identifier+'.xml']:xml(b.identifier,'0','20999999999')}]){
   await expect(verifyProductionBatchesCdr(zip(files),b,trust)).rejects.toThrow();
  }
 });
 it('never interprets acceptance when PKI verification fails',async()=>{
  await expect(verifyProductionBatchesCdr(zip(full()),b,{verify:async()=>false})).rejects.toThrow();
 });
 it('refuses conflicting member outcomes and preserves signed rejection',async()=>{
  const files=full();files[prefix+'03-'+b.entries[0].snapshot.fullNumber+'.xml']=xml(b.entries[0].snapshot.fullNumber,'2001');
  await expect(verifyProductionBatchesCdr(zip(files),b,{verify:async()=>true})).rejects.toThrow();
  const rejected=await verifyProductionBatchesCdr(zip({[prefix+b.identifier+'.xml']:xml(b.identifier,'2001')}),b,{verify:async()=>true});
  expect(rejected.status).toBe('REJECTED');
 });
 it('rejects path traversal, CRC tampering, concatenated archives and duplicate central member names',()=>{
  expect(()=>productionBatchesZipMembers(zip({'../R-evil.xml':xml('evil')}))).toThrow();
  const valid=zip(full()),bad=Buffer.from(valid);bad[50]^=1;expect(()=>productionBatchesZipMembers(bad)).toThrow();
  expect(()=>productionBatchesZipMembers(Buffer.concat([valid,valid]))).toThrow();
  const dup=zip({'R-a.xml':xml('a'),'R-b.xml':xml('b')});for(let i=0;i<dup.length-7;i++)if(dup.subarray(i,i+7).toString()==='R-b.xml')dup.write('R-a.xml',i);
  expect(()=>productionBatchesZipMembers(dup)).toThrow();
 });
});
