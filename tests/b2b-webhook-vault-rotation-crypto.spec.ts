import {describe,it,expect} from 'vitest';
import {createCipheriv,randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {HookVault,newSigningSecret,HOOK_VAULT_MAX_CIPHERTEXT} from '../services/webhook-service/src/crypto';
const old=Buffer.alloc(32,0x11),next=Buffer.alloc(32,0x22);
const ring=(legacy=false)=>new HookVault({activeKeyVersion:'new',keys:[{version:'old',key:old},{version:'new',key:next}],...(legacy?{legacyKeyVersion:'old'}:{})});
const rejected=(fn:()=>unknown)=>expect(fn).toThrow('SIGNING_KEY_UNAVAILABLE');

describe('B2B-09 HookVault custody keyring',()=>{
  it('preserves the Buffer32 constructor and exact legacy base64 wire format',()=>{
    const v=new HookVault(old),secret=newSigningSecret(),id=randomUUID(),sealed=v.seal(secret,id);
    expect(sealed).toMatch(/^[A-Za-z0-9+/]{104}$/);expect(Buffer.from(sealed,'base64')).toHaveLength(78);
    expect(v.open(sealed,id)).toBe(secret);expect(ring(true).open(sealed,id)).toBe(secret);
    rejected(()=>ring().open(sealed,id));rejected(()=>new HookVault(next).open(sealed,id));
    rejected(()=>new HookVault(Buffer.alloc(31)));rejected(()=>new HookVault(Buffer.alloc(33)));
  });
  it('writes only the active version and reads the explicit old key without changing signing secrets',()=>{
    const before=new HookVault({activeKeyVersion:'old',keys:[{version:'old',key:old}]}),v=ring(),secret=newSigningSecret(),id=randomUUID();
    const a=before.seal(secret,id),b=v.seal(v.open(a,id),id);
    expect(a).toMatch(/^hookvault\.1\.old\./);expect(b).toMatch(/^hookvault\.1\.new\./);expect(v.open(b,id)).toBe(secret);
    rejected(()=>before.open(b,id));expect(new HookVault({activeKeyVersion:'new',keys:[{version:'new',key:next}]}).open(b,id)).toBe(secret);
  });
  it('binds subscription, schema and key version to GCM AAD, with no fallback',()=>{
    const v=ring(true),secret=newSigningSecret(),id=randomUUID(),sealed=v.seal(secret,id);
    rejected(()=>v.open(sealed,randomUUID()));rejected(()=>v.open(sealed.replace('.new.','.old.'),id));
    rejected(()=>v.open(sealed.replace('.new.','.unknown.'),id));rejected(()=>v.open(sealed.replace('.1.','.2.'),id));
    const sameKeyOtherVersion=new HookVault({activeKeyVersion:'other',keys:[{version:'other',key:next}]});
    rejected(()=>sameKeyOtherVersion.open(sealed.replace('.new.','.other.'),id));
    // Removing the envelope must not downgrade AAD to the legacy subscription-only context.
    const downgrade=new HookVault({activeKeyVersion:'new',keys:[{version:'new',key:next}],legacyKeyVersion:'new'});
    rejected(()=>downgrade.open(sealed.split('.')[3],id));
    const iv=Buffer.alloc(12,1),c=createCipheriv('aes-256-gcm',next,iv);
    c.setAAD(Buffer.from(JSON.stringify(['another.schema',id,'new'])));
    const bytes=Buffer.concat([c.update(secret),c.final()]);
    rejected(()=>v.open('hookvault.1.new.'+Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64'),id));
  });
  it('rejects tampering in IV, tag and ciphertext, truncation, excess input and noncanonical encodings',()=>{
    const v=ring(),id=randomUUID(),sealed=v.seal(newSigningSecret(),id),payload=sealed.split('.')[3];
    for(const index of [0,12,28,77]){const b=Buffer.from(payload,'base64');b[index]^=1;rejected(()=>v.open('hookvault.1.new.'+b.toString('base64'),id));}
    for(const bad of ['',payload.slice(1),payload+'=',payload+'\n',sealed+'.extra','x'.repeat(HOOK_VAULT_MAX_CIPHERTEXT+1),'hookvault.1..'+payload])rejected(()=>v.open(bad,id));
    rejected(()=>v.seal('not-a-signing-secret',id));rejected(()=>v.open(sealed,''));
  });
  it('limits the keyring to two distinct dedicated keys and explicit valid versions',()=>{
    const bad:any[]=[{activeKeyVersion:'new',keys:[]},{activeKeyVersion:'absent',keys:[{version:'new',key:next}]},
      {activeKeyVersion:'new',keys:[{version:'new',key:next},{version:'old',key:old},{version:'third',key:Buffer.alloc(32,3)}]},
      {activeKeyVersion:'new',keys:[{version:'new',key:next},{version:'new',key:old}]},
      {activeKeyVersion:'new',keys:[{version:'new',key:next},{version:'old',key:next}]},
      {activeKeyVersion:'new',keys:[{version:'new',key:next}],legacyKeyVersion:'absent'},
      {activeKeyVersion:'legacy',keys:[{version:'legacy',key:old}]},{activeKeyVersion:'new',keys:[{version:'new',key:Buffer.alloc(31)}]}];
    for(const config of bad)rejected(()=>new HookVault(config));
  });
  it('copies caller key buffers and exposes no custody material through JSON, fields, inspection or errors',()=>{
    const input=Buffer.from(next),v=new HookVault({activeKeyVersion:'new',keys:[{version:'new',key:input}]}),id=randomUUID(),secret=newSigningSecret(),sealed=v.seal(secret,id);
    input.fill(0);expect(v.open(sealed,id)).toBe(secret);expect(Object.keys(v)).toEqual([]);expect(JSON.stringify(v)).toBe('{}');
    expect(inspect(v,{showHidden:true,depth:10})).not.toMatch(/Buffer|222222|whsec_/);
    const metadata=v.metadata();metadata.readableKeyVersions.push('injected');expect(v.metadata().readableKeyVersions).toEqual(['new']);
    try{v.open(sealed,randomUUID());}catch(e){expect(String(e)).toBe('Error: SIGNING_KEY_UNAVAILABLE');expect(JSON.stringify(e)).not.toContain(secret);}
  });
});
