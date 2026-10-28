import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,linkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {inspect} from 'node:util';
import {loadMailerSmtpOwnerMount} from '../services/mailer-worker/src/b2b/host-smtp';
const roots:string[]=[];
const metadata=()=>({schemaVersion:'factuez.b2b.mailer-smtp-host.v1',environment:'BETA',profile:'PREPARED_ONLY',keyFile:'smtp-key.bin',keyVersion:1,approvedHosts:['smtp.example.com']});
function mount(data:unknown=metadata(),key=randomBytes(32)){
 const root=mkdtempSync(join(tmpdir(),'b2b-smtp-mount-synthetic-'));roots.push(root);
 writeFileSync(join(root,'smtp-host.json'),JSON.stringify(data),{mode:0o600});writeFileSync(join(root,'smtp-key.bin'),key,{mode:0o600});return {root,key};
}
afterEach(()=>{for(const root of roots.splice(0)){if(dirname(root)!==tmpdir()||!root.includes('b2b-smtp-mount-synthetic-'))throw Error('INVALID_TEST_CLEANUP');rmSync(root,{recursive:true,force:true});}});
describe('fixed mounted BETA SMTP preparation',()=>{
 it('reads only explicit metadata and binary key; hides and erases its private buffer',()=>{
  const fixture=mount(),loaded=loadMailerSmtpOwnerMount(fixture.root),key=loaded.key;
  expect(loaded.keyVersion).toBe(1);expect(loaded.approvedHosts).toEqual(['smtp.example.com']);expect(key.equals(fixture.key)).toBe(true);
  expect(Object.values(loaded)).toEqual([]);expect(JSON.stringify(loaded)).not.toContain(fixture.key.toString('hex'));expect(inspect(loaded)).not.toContain('Buffer');
  expect(()=>JSON.stringify(loaded)).not.toThrow();loaded.close();loaded.close();expect(key.every(byte=>byte===0)).toBe(true);expect(()=>loaded.key).toThrow('MOUNT_INVALID');
 });
 it.each([
  {environment:'PRODUCTION'},{environment:'QA'},{profile:'CORPORATE'},{schemaVersion:'wrong'},{keyFile:'../smtp-key.bin'},{keyFile:'alternate.bin'},
  {keyVersion:0},{keyVersion:10001},{keyVersion:'1'},{approvedHosts:[]},{approvedHosts:['smtp.example.com','smtp.example.com']},
  {approvedHosts:['127.0.0.1']},{approvedHosts:['smtp.internal']},{approvedHosts:['*.example.com']},{approvedHosts:['SMTP.EXAMPLE.COM']},{extra:'forbidden'},
 ])('rejects nonexact metadata %j',change=>{
  const fixture=mount({...metadata(),...change});expect(()=>loadMailerSmtpOwnerMount(fixture.root)).toThrow('B2B_MAILER_SMTP_MOUNT_INVALID');
 });
 it.each([1,31,33,64])('rejects a %i-byte mounted key',size=>{
  const fixture=mount(metadata(),randomBytes(size));expect(()=>loadMailerSmtpOwnerMount(fixture.root)).toThrow('MOUNT_INVALID');
 });
 it('rejects absent/aliased/hardlinked files and sanitizes filesystem details',()=>{
  const fixture=mount();rmSync(join(fixture.root,'smtp-key.bin'));expect(()=>loadMailerSmtpOwnerMount(fixture.root)).toThrow('B2B_MAILER_SMTP_MOUNT_INVALID');
  writeFileSync(join(fixture.root,'original.bin'),randomBytes(32));linkSync(join(fixture.root,'original.bin'),join(fixture.root,'smtp-key.bin'));
  expect(()=>loadMailerSmtpOwnerMount(fixture.root)).toThrow('B2B_MAILER_SMTP_MOUNT_INVALID');
  expect(()=>loadMailerSmtpOwnerMount('relative-private-root')).toThrow('B2B_MAILER_SMTP_MOUNT_INVALID');
 });
});
