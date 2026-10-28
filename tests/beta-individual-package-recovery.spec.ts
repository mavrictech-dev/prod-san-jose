import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {describe,it,expect,vi} from 'vitest';
import {BetaIssuanceService} from '../services/sunat-service/src/application/beta-issuance.service';
const {zipSync}=createRequire(new URL('../services/sunat-service/package.json',import.meta.url))('fflate') as typeof import('fflate');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const ruc='20100070970',documentId='11111111-1111-4111-8111-111111111111',rc=Buffer.from('summary synthetic'),xml=Buffer.from('member synthetic');
 const zip=Buffer.from(zipSync({[`${ruc}-RC-20261003-1.xml`]:rc})),individual=Buffer.from(zipSync({[`${ruc}-03-B001-1.xml`]:xml}));
 const artifact=(key:string,b:Buffer)=>({storageKey:key,sha256:sha(b),sizeBytes:b.length});
 const manifest={fileName:`${ruc}-RC-20261003-1.zip`,reference:'RC-20261003-1',revision:1,requestOwnerId:'batch',xml:artifact('summary.xml',rc),zip:artifact('summary.zip',zip),documentXml:artifact('member.xml',xml),individualXmlZip:artifact('member.zip',individual)};
 const values=new Map([['summary.xml',rc],['summary.zip',zip],['member.xml',xml],['member.zip',individual]]);
 const store={read:vi.fn(async(_id:string,a:{storageKey:string})=>values.get(a.storageKey))};
 const xsd={validate:vi.fn(async(b:Buffer)=>({xmlSha256:sha(b)}))};
 const svc=new BetaIssuanceService({} as never,{manifest:async()=>manifest} as never,store as never,{} as never,{} as never,{} as never,{} as never,xsd as never,{} as never);
 const inner=svc as any;inner.context=async()=>{};
 return {manifest,values,run:()=>inner.archived({documentId,snapshot:{documentTypeCode:'03',issuer:{identityNumber:ruc},fullNumber:'B001-1'}})};
}
describe('recuperación Beta de boleta y resumen separados',()=>{
 it('verifica ambos archivos y recupera solo el RC como solicitud',async()=>{
  const f=fixture();expect((await f.run()).zip).toEqual(f.values.get('summary.zip'));
 });
 it('rechaza un ZIP individual que contiene otro XML',async()=>{
  const f=fixture();f.values.set('member.zip',Buffer.from(zipSync({'20100070970-03-B001-1.xml':Buffer.from('otro')})));
  await expect(f.run()).rejects.toThrow('ZIP individual inconsistente');
 });
 it('permite recuperar manifiestos históricos sin el nuevo ZIP',async()=>{
  const f=fixture();delete (f.manifest as any).individualXmlZip;expect(await f.run()).toBeTruthy();
 });
});
