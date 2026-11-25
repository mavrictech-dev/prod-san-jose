import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const {provision}=createRequire(import.meta.url)('../scripts/provision-native-gre.cjs');
const {configure}=createRequire(import.meta.url)('../scripts/configure-native-b2b.cjs');
it('provisions empty Docker placeholders once and refuses any existing key material',()=>{
 const parent=mkdtempSync(join(tmpdir(),'factuez-gre-placeholder-')),target=join(parent,'gre');
 try{
  mkdirSync(target);for(const side of ['identity','billing','sunat'])mkdirSync(join(target,side));
  expect(()=>provision(resolve('.'),target)).toThrow('NEW_GRE_DIRECTORY_REQUIRED');
  writeFileSync(join(target,'billing','existing.key'),'retain-me');
  expect(()=>provision(resolve('.'),target,{allowEmptyPlaceholder:true})).toThrow('NEW_GRE_DIRECTORY_REQUIRED');
  expect(readFileSync(join(target,'billing','existing.key'),'utf8')).toBe('retain-me');
  rmSync(join(target,'billing','existing.key'));
  expect(provision(resolve('.'),target,{allowEmptyPlaceholder:true}).transmissionActivated).toBe(false);
  const key=readFileSync(join(target,'billing','signing-private.pem'));
  expect(()=>provision(resolve('.'),target,{allowEmptyPlaceholder:true})).toThrow('NEW_GRE_DIRECTORY_REQUIRED');
  expect(readFileSync(join(target,'billing','signing-private.pem'))).toEqual(key);
  const files=readdirSync(join(target,'billing')).sort(),before=JSON.parse(readFileSync(join(target,'billing','config.json'),'utf8'));
  expect(configure(target)).toMatchObject({transport:'EXISTING_IDENTITY_RETAINED',fiscalDispatchActivated:false});
  expect(readdirSync(join(target,'billing')).sort()).toEqual(files);
  const after=JSON.parse(readFileSync(join(target,'billing','config.json'),'utf8'));
  expect(after.peers).toEqual(before.peers);expect(after.b2b.peers).toHaveLength(2);
  expect(readFileSync(join(target,'billing','signing-private.pem'))).toEqual(key);
  expect(readdirSync(join(target,'b2b-config-backups'))).toHaveLength(3);
  expect(configure(target).fiscalDispatchActivated).toBe(false);
  expect(readdirSync(join(target,'b2b-config-backups'))).toHaveLength(3);
 }finally{rmSync(parent,{recursive:true,force:true});}
},60000);
