'use strict';
// Public material only. No vault, P12, application configuration or network access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
// Deliberate code review is required to rotate these anchors, as well as the manifest.
const REVIEWED_PINS=Object.freeze({root:'fe2e0a11b68d2a11532daebd0566c66a9d3684e23d617e3c2dc8ba836bb9a774',signers:'148cae1801a14eb5dabe6fa55cce315951c026a6c95397de984dbc3a92f74a5a',fingerprint:'a449c6652ac87d3fa615b03f9f238821efb8e7710f6adb40c9d5872ce53e7a54'});
function verifyPublicBundle(staging,reviewed,openssl='/usr/bin/openssl',pins=REVIEWED_PINS){
 if(!path.isAbsolute(staging)||!path.isAbsolute(reviewed)||!path.isAbsolute(openssl))throw Error('ABSOLUTE_PATHS_REQUIRED');
 const read=(dir,name)=>{const p=path.join(dir,name),stat=fs.lstatSync(p);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('PUBLIC_FILE_INVALID');const bytes=fs.readFileSync(p);if(bytes.includes(Buffer.from('PRIVATE KEY')))throw Error('PRIVATE_MATERIAL_NOT_ALLOWED');return bytes;};
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const manifest=JSON.parse(read(reviewed,'manifest.json').toString('utf8'));
 if(manifest.version!=='factuez.reviewed-public-pki.v1')throw Error('REVIEWED_MANIFEST_REQUIRED');
 if(manifest.files?.['issuer-roots.pem']!==pins.root||manifest.files?.['cdr-signers.pem']!==pins.signers||manifest.sunatSignerFingerprint!==pins.fingerprint)throw Error('REVIEWED_ANCHOR_CHANGED');
 for(const name of ['issuer-roots.pem','cdr-signers.pem'])if(sha(read(reviewed,name))!==manifest.files[name])throw Error('REVIEWED_PUBLIC_PIN_CHANGED');
 const rootBytes=read(reviewed,'issuer-roots.pem'),signerBytes=read(reviewed,'cdr-signers.pem');
 const roots=rootBytes.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];
 const chain=signerBytes.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];
 if(roots.length!==1||chain.length!==2)throw Error('REVIEWED_CHAIN_REQUIRED');
 const root=new crypto.X509Certificate(roots[0]),leaf=new crypto.X509Certificate(chain[0]),intermediate=new crypto.X509Certificate(chain[1]);
 if(!root.ca||!root.verify(root.publicKey)||!intermediate.ca||!intermediate.verify(root.publicKey)||!leaf.verify(intermediate.publicKey))throw Error('PUBLIC_CERTIFICATE_CHAIN_INVALID');
 const now=Date.now();for(const c of [root,intermediate,leaf])if(now<Date.parse(c.validFrom)||now>=Date.parse(c.validTo))throw Error('PUBLIC_CERTIFICATE_EXPIRED_OR_NOT_YET_VALID');
 if(leaf.fingerprint256.replaceAll(':','').toLowerCase()!==manifest.sunatSignerFingerprint)throw Error('SUNAT_SIGNER_PIN_CHANGED');
 const exec=args=>{const p=spawnSync(openssl,args,{encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024,windowsHide:true});if(p.error||p.status!==0)throw Error('PUBLIC_PKI_CRYPTOGRAPHIC_CHECK_FAILED');return p.stdout;};
 fs.writeFileSync(path.join(staging,'roots.verify.pem'),rootBytes);fs.writeFileSync(path.join(staging,'intermediate.verify.pem'),chain[1]+'\n');fs.writeFileSync(path.join(staging,'signer.verify.pem'),chain[0]+'\n');
 const crls=[],expiry=[];
 for(const [source,issuer]of [['root.crl','roots.verify.pem'],['intermediate.crl','intermediate.verify.pem']]){
  const bytes=read(staging,source),pem=path.join(staging,source+'.pem');
  const text=exec(['crl','-inform',bytes.toString('ascii',0,11)==='-----BEGIN '?'PEM':'DER','-in',path.join(staging,source),'-outform','PEM']);
  fs.writeFileSync(pem,text);exec(['crl','-in',pem,'-noout','-verify','-CAfile',path.join(staging,issuer)]);
  const dates=exec(['crl','-in',pem,'-noout','-lastupdate','-nextupdate']);
  const before=Date.parse(dates.match(/^lastUpdate=(.+)$/m)?.[1]||''),after=Date.parse(dates.match(/^nextUpdate=(.+)$/m)?.[1]||'');
  if(!Number.isFinite(before)||!Number.isFinite(after)||now<before||now>=after)throw Error('CRL_EXPIRED_OR_NOT_YET_VALID');
  expiry.push(after);crls.push(Buffer.from(text));
 }
 const bundle=Buffer.concat(crls);fs.writeFileSync(path.join(staging,'crls.pem'),bundle);
 exec(['verify','-CAfile',path.join(staging,'roots.verify.pem'),'-untrusted',path.join(staging,'intermediate.verify.pem'),'-CRLfile',path.join(staging,'crls.pem'),'-crl_check_all','-x509_strict','-check_ss_sig',path.join(staging,'signer.verify.pem')]);
 const files={'issuer-roots.pem':rootBytes,'crls.pem':bundle,'cdr-signers.pem':signerBytes};
 for(const [name,bytes]of Object.entries(files))fs.writeFileSync(path.join(staging,name),bytes);
 const result={verified:true,checkedAt:new Date(now).toISOString(),crlExpiresAt:new Date(Math.min(...expiry)).toISOString(),sunatSignerFingerprint:manifest.sunatSignerFingerprint,hashes:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha(b)])),transmissionActivated:false};
 fs.writeFileSync(path.join(staging,'verification.json'),JSON.stringify(result,null,2)+'\n');return result;
}
function verifyInstalledBundle(installed,reviewed,staging,openssl='/usr/bin/openssl',pins=REVIEWED_PINS){
 if(![installed,reviewed,staging,openssl].every(path.isAbsolute)||new Set([installed,reviewed,staging].map(p=>path.resolve(p))).size!==3)throw Error('DISTINCT_ABSOLUTE_PATHS_REQUIRED');
 const files={};
 for(const name of ['issuer-roots.pem','cdr-signers.pem','crls.pem']){
  const p=path.join(installed,name),s=fs.lstatSync(p);
  if(!s.isFile()||s.isSymbolicLink()||!s.size||s.size>1024*1024)throw Error('PUBLIC_FILE_INVALID');
  files[name]=fs.readFileSync(p);if(files[name].includes(Buffer.from('PRIVATE KEY')))throw Error('PRIVATE_MATERIAL_NOT_ALLOWED');
 }
 for(const name of ['issuer-roots.pem','cdr-signers.pem'])if(!files[name].equals(fs.readFileSync(path.join(reviewed,name))))throw Error('INSTALLED_REVIEWED_PIN_MISMATCH');
 const text=files['crls.pem'].toString('utf8'),crls=text.match(/-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g)||[];
 if(crls.length!==2||text.replace(/-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g,'').trim())throw Error('TWO_SIGNED_CRLS_REQUIRED');
 fs.writeFileSync(path.join(staging,'root.crl'),crls[0]+'\n');fs.writeFileSync(path.join(staging,'intermediate.crl'),crls[1]+'\n');
 const result=verifyPublicBundle(staging,reviewed,openssl,pins);
 // The hashes applied belong to the exact installed bytes, including PEM whitespace.
 result.hashes=Object.fromEntries(Object.entries(files).map(([n,b])=>[n,crypto.createHash('sha256').update(b).digest('hex')]));
 fs.writeFileSync(path.join(staging,'verification.json'),JSON.stringify(result,null,2)+'\n');return result;
}
module.exports={verifyPublicBundle,verifyInstalledBundle};
if(require.main===module){try{
 const args=process.argv.slice(2);
 const result=args.length===4&&args[0]==='--installed'?verifyInstalledBundle(...args.slice(1).map(p=>path.resolve(p))):args.length===2?verifyPublicBundle(...args.map(p=>path.resolve(p))):(()=>{throw Error('PUBLIC_PKI_ARGUMENTS_INVALID');})();
 console.log(JSON.stringify(result));
}catch(e){console.error(e.code?'PUBLIC_PKI_INPUT_UNAVAILABLE':e.message);process.exitCode=1;}}
