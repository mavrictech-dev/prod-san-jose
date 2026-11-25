import {NativeB2bBillingAuthority} from './native-b2b-authority';
import {loadNativeGreConfig,nativeGreKeys,nativeGreSigning,nativeGreTls} from '@factuez/service-access';
import {ProductionGuidesPrivateHttp} from '@factuez/sunat-core/dist/production-guides-private';
import {createProductionGuidesBilling} from './production-guides-assembly';
import {ProductionGuidesOwner,type ProductionGuidesBillingDb} from './production-guides-owner';
export function productionGuidesBillingHost(db:ProductionGuidesBillingDb,authority?:NativeB2bBillingAuthority){
 const c=loadNativeGreConfig();if(!c)return {owner:new ProductionGuidesOwner(db),privatePeers:[],runtime:null,close:()=>{}};
 if(!c.remote||!c.identity)throw Error('GRE_REMOTE_AND_IDENTITY_REQUIRED');
 const http=new ProductionGuidesPrivateHttp(c.identity.origin,nativeGreTls(c,c.identity));
 const a=createProductionGuidesBilling({database:db,authority,serviceCurrent:async(service,scope)=>{
   if(!authority)throw Error('NATIVE_B2B_UNAVAILABLE');
   const current=await authority.rpc().post('identity','/internal/native-b2b/identity/current',{clientId:service.clientId});
   if(!current.enabled||current.kind!=='SERVICE'||current.environment!=='PRODUCTION'||current.revision!==service.revision)return {active:false,canIssue:false,scope:{kind:'ASSIGNED',branchIds:[],emissionPointIds:[],series:[]}};
   const bindings=await authority.fromGrants(current.grants.filter((g:any)=>g.scope==='production:guides:issue:09'||g.scope==='production:guides:issue:31'));
   const match=bindings.find(b=>b.seriesId===scope.seriesCounterId&&b.companyId===scope.companyId&&b.issuerRuc===scope.issuerRuc&&b.branchId===scope.branchId&&b.pointId===scope.pointId);
   return {active:true,canIssue:!!match,scope:{kind:'ASSIGNED',branchIds:match?[match.branchId]:[],emissionPointIds:match?[match.pointId]:[],series:match?[match.seriesId]:[]}};
  },enabled:()=>process.env.NATIVE_GRE_ENABLED==='true'&&process.env.NATIVE_GRE_WORKERS_ENABLED==='true',runWorkers:true,ownerSigning:nativeGreSigning(c),ownerPublicKeys:nativeGreKeys(c.ownerPublicKeys),sunatPublicKeys:nativeGreKeys(c.sunatPublicKeys),sunat:{origin:c.remote.origin,tls:nativeGreTls(c,c.remote),allowedPeerFingerprints:c.peers},identity:{current:userId=>http.post('/internal/production-guides/identity/current',{userId})}});
 return {...a,close:()=>{a.close();http.close();}};
}
