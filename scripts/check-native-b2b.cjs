'use strict';
// Executes inside the existing non-root service. Uses only its mounted transport identity.
const {NativeB2bRpc}=require('../packages/service-access/dist/native-b2b-rpc');
async function check(side){
 if(!['identity','billing','fiscal'].includes(side))throw Error('EXACT_SERVICE_ROLE_REQUIRED');
 const rpc=NativeB2bRpc.configured(),targets=side==='billing'?['identity','fiscal']:['billing'];
 try{for(const owner of targets){const result=await rpc.post(owner,'/internal/native-b2b/'+owner+'/health',{});if(result?.profile!=='NATIVE_B2B'||result.owner!==owner||result.state!=='PRIVATE_CHANNEL_AVAILABLE')throw Error('PRIVATE_CHANNEL_RESULT_MISMATCH');}return {profile:'NATIVE_B2B',owner:side,verifiedPeers:targets,fiscalAcceptance:'NOT_ESTABLISHED'};}finally{rpc.close();}
}
module.exports={check};if(require.main===module)check(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('NATIVE_B2B_PRIVATE_CHANNEL_BLOCKED');process.exitCode=1;});
