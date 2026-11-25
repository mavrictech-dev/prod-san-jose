import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
const local=createRequire(import.meta.url),{verifyPublicBundle}=local('../scripts/verify-public-fiscal-pki.cjs');
let root:string,sequence=0;
const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'/usr/bin/openssl';
beforeAll(()=>{root=mkdtempSync(join(tmpdir(),'factuez-public-pki-test-'));});
afterAll(()=>{const rel=relative(resolve(tmpdir()),resolve(root));if(!rel.startsWith('factuez-public-pki-test-')||rel.includes('..'))throw Error('TEMP_TARGET_NOT_OWNED');rmSync(root,{recursive:true});});
function fixture(){const dir=join(root,String(++sequence)),reviewed=join(dir,'reviewed'),staging=join(dir,'staging');mkdirSync(dir);mkdirSync(staging);cpSync(resolve('infra/deployment/windows-test/public-pki'),reviewed,{recursive:true});return {reviewed,staging};}
describe('reviewed public fiscal PKI preparation fails closed',()=>{
 it('requires absolute explicit paths',()=>{expect(()=>verifyPublicBundle('relative',root,openssl)).toThrow('ABSOLUTE_PATHS_REQUIRED');});
 it('rejects root bytes that differ from the reviewed hash before writing a bundle',()=>{const {reviewed,staging}=fixture();writeFileSync(join(reviewed,'issuer-roots.pem'),'changed');expect(()=>verifyPublicBundle(staging,reviewed,openssl)).toThrow('REVIEWED_PUBLIC_PIN_CHANGED');expect(readdirSync(staging)).toEqual([]);});
 it('rejects changed signer bytes independently of the CA anchor',()=>{const {reviewed,staging}=fixture();writeFileSync(join(reviewed,'cdr-signers.pem'),'changed');expect(()=>verifyPublicBundle(staging,reviewed,openssl)).toThrow('REVIEWED_PUBLIC_PIN_CHANGED');expect(readdirSync(staging)).toEqual([]);});
 it('refuses private key material in an input advertised as public',()=>{const {reviewed,staging}=fixture();writeFileSync(join(reviewed,'issuer-roots.pem'),'-----BEGIN PRIVATE KEY-----\nSYNTHETIC-MARKER-NOT-A-KEY');expect(()=>verifyPublicBundle(staging,reviewed,openssl)).toThrow('PRIVATE_MATERIAL_NOT_ALLOWED');});
 it('rejects an unknown manifest version',()=>{const {reviewed,staging}=fixture(),p=join(reviewed,'manifest.json'),m=JSON.parse(readFileSync(p,'utf8'));m.version='unreviewed';writeFileSync(p,JSON.stringify(m));expect(()=>verifyPublicBundle(staging,reviewed,openssl)).toThrow('REVIEWED_MANIFEST_REQUIRED');});
 it('never publishes verified status when current CRL evidence is malformed',()=>{expect(existsSync(openssl)).toBe(true);const {reviewed,staging}=fixture();writeFileSync(join(staging,'root.crl'),'NOT-A-CRL');writeFileSync(join(staging,'intermediate.crl'),'NOT-A-CRL');expect(()=>verifyPublicBundle(staging,reviewed,openssl)).toThrow();expect(existsSync(join(staging,'verification.json'))).toBe(false);});
});
