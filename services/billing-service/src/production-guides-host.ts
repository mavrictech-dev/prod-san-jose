import {loadNativeGreConfig,nativeGreKeys,nativeGreSigning,nativeGreTls} from '@factuez/service-access';
import {ProductionGuidesPrivateHttp} from '@factuez/sunat-core/dist/production-guides-private';
import {createProductionGuidesBilling} from './production-guides-assembly';
import {ProductionGuidesOwner,type ProductionGuidesBillingDb} from './production-guides-owner';
export function productionGuidesBillingHost(db:ProductionGuidesBillingDb){
 const c=loadNativeGreConfig();if(!c)return {owner:new ProductionGuidesOwner(db),privatePeers:[],runtime:null,close:()=>{}};
 if(!c.remote||!c.identity)throw Error('GRE_REMOTE_AND_IDENTITY_REQUIRED');
 const http=new ProductionGuidesPrivateHttp(c.identity.origin,nativeGreTls(c,c.identity));
 const a=createProductionGuidesBilling({database:db,enabled:()=>process.env.NATIVE_GRE_ENABLED==='true'&&process.env.NATIVE_GRE_WORKERS_ENABLED==='true',runWorkers:true,ownerSigning:nativeGreSigning(c),ownerPublicKeys:nativeGreKeys(c.ownerPublicKeys),sunatPublicKeys:nativeGreKeys(c.sunatPublicKeys),sunat:{origin:c.remote.origin,tls:nativeGreTls(c,c.remote),allowedPeerFingerprints:c.peers},identity:{current:userId=>http.post('/internal/production-guides/identity/current',{userId})}});
 return {...a,close:()=>{a.close();http.close();}};
}
