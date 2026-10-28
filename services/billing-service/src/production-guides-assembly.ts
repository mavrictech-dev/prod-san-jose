import type { KeyObject } from 'node:crypto';
import type { AccessScope } from '@factuez/contracts';
import { createProductionGuidesSigner,createProductionGuidesVerifier } from '@factuez/sunat-core/dist/production-guides';
import { ProductionGuidesPrivateHttp,type ProductionGuidesPrivateTls } from '@factuez/sunat-core/dist/production-guides-private';
import { ProductionGuidesOwner,type ProductionGuidesBillingDb } from './production-guides-owner';
import { ProductionGuidesSunatPrivateClient } from './production-guides-private';
import { ProductionGuidesBillingRuntime } from './production-guides-runtime';
export type ProductionGuidesBillingAssemblyInput={
 database:ProductionGuidesBillingDb;enabled?:()=>boolean;runWorkers?:boolean;
 ownerSigning:{keyId:string;key:KeyObject};ownerPublicKeys:ReadonlyMap<string,KeyObject>;sunatPublicKeys:ReadonlyMap<string,KeyObject>;
 sunat:{origin:string;tls:ProductionGuidesPrivateTls;allowedPeerFingerprints:readonly string[]};
 /** Existing Identity LinkedUsers.current contract. Caller supplies the authenticated private Identity capability, never a user claim. */
 identity:{current(userId:string):Promise<{active:boolean;permissions:string[];scope:AccessScope}>};now?:()=>string;
};
export function createProductionGuidesBilling(input:ProductionGuidesBillingAssemblyInput){
 const enabled=input.enabled??(()=>false),http=new ProductionGuidesPrivateHttp(input.sunat.origin,input.sunat.tls),sunat=new ProductionGuidesSunatPrivateClient(http);
 const owner=new ProductionGuidesOwner(input.database,{enabled,signer:createProductionGuidesSigner(input.ownerSigning.keyId,input.ownerSigning.key),ownerVerifier:createProductionGuidesVerifier(input.ownerPublicKeys),statusVerifier:createProductionGuidesVerifier(input.sunatPublicKeys),actorCurrent:async id=>{const u=await input.identity.current(id);return {active:u.active,canIssue:u.permissions.includes('document.issue'),scope:u.scope};},sunat,now:input.now});
 const runtime=new ProductionGuidesBillingRuntime(input.database,owner,sunat,enabled).enableLifecycle(input.runWorkers===true);
 return {owner,runtime,privatePeers:Object.freeze([...input.sunat.allowedPeerFingerprints]),close:()=>http.close()};
}
