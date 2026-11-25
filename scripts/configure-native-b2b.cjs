'use strict';
// Adds purpose-specific peer authorization to the EXISTING transport identity.
// It never generates a key, changes GRE peers, enables fiscal dispatch or reads SOL.
const {readFileSync,writeFileSync,renameSync,existsSync,realpathSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {X509Certificate,createPrivateKey,createPublicKey,createHash}=require('node:crypto');
function configure(target){
 const root=realpathSync(target),sides=['identity','billing','sunat'],configs={},pins={},ca=[];
 for(const side of sides){
  const dir=join(root,side),file=join(dir,'config.json'),c=JSON.parse(readFileSync(file,'utf8'));
  if(realpathSync(dir)!==dir||c.version!=='factuez.native-gre.host.v1'||c.listener?.port!==({identity:3441,billing:3442,sunat:3443})[side]||c.listener?.certFile!=='/run/gre/transport-cert.pem'||c.listener.keyFile!=='/run/gre/transport-key.pem'||c.listener.caFile!=='/run/gre/ca.pem')throw Error('EXISTING_TRANSPORT_REQUIRED');
  const cert=new X509Certificate(readFileSync(join(dir,'transport-cert.pem'))),key=readFileSync(join(dir,'transport-key.pem'));
  try{if(!createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'}).equals(cert.publicKey.export({type:'spki',format:'der'})))throw Error('TRANSPORT_KEY_MISMATCH');}finally{key.fill(0);}
  if(Date.parse(cert.validTo)<=Date.now()||Date.parse(cert.validFrom)>Date.now())throw Error('TRANSPORT_CERTIFICATE_EXPIRED');
  pins[side]=cert.fingerprint256.replaceAll(':','').toLowerCase();configs[side]={c,file};ca.push(createHash('sha256').update(readFileSync(join(dir,'ca.pem'))).digest('hex'));
 }
 const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
 if(new Set(ca).size!==1||sides.some(s=>manifest.transportFingerprints?.[s]!==pins[s]))throw Error('EXISTING_TRANSPORT_PIN_MISMATCH');
 const peers={identity:[pins.billing,pins.sunat],billing:[pins.identity,pins.sunat],sunat:[pins.billing]};
 const endpoints={identity:{origin:'https://identity-service:3441',serverFingerprint:pins.identity},billing:{origin:'https://billing-service:3442',serverFingerprint:pins.billing},fiscal:{origin:'https://sunat-service:3443',serverFingerprint:pins.sunat}};
 for(const side of sides){
  const {c,file}=configs[side];if(c.peers.some(pin=>!Object.values(pins).includes(pin)))throw Error('UNKNOWN_LEGACY_GRE_PEER');
  const next={...c,b2b:{peers:peers[side],...endpoints}},text=JSON.stringify(next,null,2)+'\n',old=readFileSync(file,'utf8');
  if(text===old)continue;
  const backup=file+'.before-b2b-'+createHash('sha256').update(old).digest('hex').slice(0,16);
  if(!existsSync(backup))writeFileSync(backup,old,{flag:'wx',mode:0o600});
  const temporary=file+'.b2b-next';writeFileSync(temporary,text,{flag:'wx',mode:0o600});renameSync(temporary,file);
 }
 return {profile:'NATIVE_B2B',transport:'EXISTING_IDENTITY_RETAINED',legacyGrePeers:'UNCHANGED',fiscalDispatchActivated:false};
}
module.exports={configure};if(require.main===module){try{if(process.argv.length!==3)throw Error();console.log(JSON.stringify(configure(resolve(process.argv[2]))));}catch(error){console.error('NATIVE_B2B_TRANSPORT_BLOCKED: '+error.message);process.exitCode=1;}}
