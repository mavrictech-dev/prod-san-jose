const {generateKeyPairSync,sign}=require('node:crypto');
const f=require('./history-full-fixtures.cjs');
// Own ephemeral JWT key only. Never reads the configured company/SUNAT key.
function jwtFixture(){
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const now=Math.floor(Date.now()/1000);
  function claims(actor=f.actor()){
    return {sub:actor.userId,username:'ficticio-qa',roles:actor.roles,permissions:['document.view'],
      scope:actor.scope.kind==='GLOBAL'?{kind:'GLOBAL'}:{kind:'ASSIGNED',branchIds:actor.scope.branchIds,
        emissionPointIds:actor.scope.emissionPointIds,series:actor.scope.seriesCounterIds},
      authVersion:0,iss:'factuez-identity',aud:'factuez-services',iat:now-1,exp:now+600};
  }
  function token(payload=claims(),header={alg:'RS256',typ:'JWT'}){
    const parts=[header,payload].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url'));
    const bytes=parts.join('.');return `${bytes}.${sign('RSA-SHA256',Buffer.from(bytes),privateKey).toString('base64url')}`;
  }
  return {publicKey,claims,token,now};
}
module.exports={jwtFixture};
