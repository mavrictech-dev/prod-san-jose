import {readFileSync} from 'node:fs';
import {loadNativeGreConfig,nativeGreKeys,nativeGreSigning,nativeGreTls} from '@factuez/service-access';
import {createProductionGuidesSunat} from './production-guides-assembly';
import {ProductionGuidesStore,type ProductionGuidesDatabase} from './production-guides-store';
import {ProductionGuidesService} from './production-guides-service';
export function productionGuidesSunatHost(db:ProductionGuidesDatabase){
 const c=loadNativeGreConfig();if(!c){const store=new ProductionGuidesStore(db,{sign(){throw Error('GRE_DISABLED');}},'LOCAL_SYNTHETIC');return {store,service:new ProductionGuidesService(store),runtime:null,privatePeers:[],grantEvidence:async()=>{throw Error('GRE_CONFIG_REQUIRED');},readiness:async()=>({ready:false,blockers:['Configuración privada del runtime SUNAT pendiente']}),close:()=>{}};}
 if(!c.remote||!c.cataloguesFile||!process.env.APP_MASTER_KEY_FILE)throw Error('GRE_REMOTE_CATALOGUES_VAULT_REQUIRED');
 const encoded=readFileSync(process.env.APP_MASTER_KEY_FILE,'utf8').trim(),key=/^[a-f0-9]{64}$/i.test(encoded)?Buffer.from(encoded,'hex'):Buffer.from(encoded,'base64url');
 try{return createProductionGuidesSunat({database:db,enabled:()=>process.env.NATIVE_GRE_ENABLED==='true'&&process.env.NATIVE_GRE_WORKERS_ENABLED==='true',runWorkers:true,vaultKey:key,statusSigning:nativeGreSigning(c),ownerPublicKeys:nativeGreKeys(c.ownerPublicKeys),billing:{origin:c.remote.origin,tls:nativeGreTls(c,c.remote),allowedPeerFingerprints:c.peers},catalogues:JSON.parse(readFileSync(c.cataloguesFile,'utf8'))});}finally{key.fill(0);}
}
