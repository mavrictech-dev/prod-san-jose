import { randomUUID } from 'node:crypto';
import {productionOperationUuid} from './production-native-billing';
import { authorize, binding, canonical, deny, hash, signAttestation, type ProductionActor, type ProductionBinding, type ProductionIntrospection, type ProductionScope, type ProductionStore } from '@factuez/service-access/dist/b2b-production-contract';
export const productionOperations = {read:'production:documents:read','issue01':'production:documents:issue:01','issue03':'production:documents:issue:03','note07':'production:notes:issue:07','note08':'production:notes:issue:08','guide09':'production:guides:issue:09','guide31':'production:guides:issue:31','mastersRead':'production:masters:read','mastersWrite':'production:masters:write','usersRead':'production:users:read','usersWrite':'production:users:write'} as const;
export type ProductionOperation=keyof typeof productionOperations;
export interface ProductionOwnerRequest {actor:ProductionActor;token:string;attestation:string;method:string;path:string;binding:ProductionBinding;payload:unknown;operationId:string;operation:ProductionOperation}
/** Adapter MUST revalidate current SERVICE authority, binding, PRODUCTION and native privileges.
 * It MUST durably dedupe operationId with the native business commit. No fake human sub/userId. */
export interface ProductionOwnerAdapter {execute(request:ProductionOwnerRequest):Promise<unknown>}
interface Command {hash:string;state:'PENDING'|'SUCCEEDED'|'UNCERTAIN';operationId:string;result?:unknown}
export class ProductionFacade {
 private readonly owners:Partial<Record<ProductionOperation,ProductionOwnerAdapter>>;
 constructor(private readonly identity:ProductionIntrospection,private readonly store:ProductionStore,owners:Partial<Record<ProductionOperation,ProductionOwnerAdapter>>,private readonly keyId:string,private readonly key:Buffer,private readonly administration:Partial<Record<ProductionOperation,boolean>>={}){if(!keyId||key.length<32)throw Error('ATTESTATION_KEY_REQUIRED');this.owners={...owners};}
 capabilities(){return {environment:'PRODUCTION',kind:'SERVICE',operations:Object.fromEntries(Object.keys(productionOperations).map(op=>[op,{state:this.owners[op as ProductionOperation]&&(!/^(masters|users)/.test(op)||this.administration[op as ProductionOperation]===true)?'ADAPTER_REGISTERED':'OWNER_UNRESOLVED'}]))};}
 async execute(token:string,op:ProductionOperation,b:ProductionBinding,payload:unknown,idempotencyKey:string|undefined,method:string,path:string){const scope=productionOperations[op];if(!scope)deny(404,'OPERATION_NOT_FOUND');binding(b);const actor=await this.identity.introspect(token);authorize(actor,scope,b);
 const adapter=this.owners[op];if(!adapter||/^(masters|users)/.test(op)&&this.administration[op]!==true)deny(503,'OWNER_UNRESOLVED');const read=op==='read'||op.endsWith('Read');if(!read&&(!idempotencyKey||!/^[A-Za-z0-9_-]{1,100}$/.test(idempotencyKey)))deny(400,'IDEMPOTENCY_KEY_REQUIRED');
 const commandKey=hash(canonical({clientId:actor.clientId,op,b,key:idempotencyKey})),requestHash=hash(canonical({op,b,payload})),operationId=read?randomUUID():productionOperationUuid(commandKey);
 if(!read){const old=await this.store.transaction(['command:'+commandKey],async tx=>{const c=await tx.get<Command>('command',commandKey);if(c){if(c.hash!==requestHash)deny(409,'IDEMPOTENCY_CONFLICT');return c;}await tx.put('command',commandKey,{hash:requestHash,state:'PENDING',operationId});await tx.put('audit',randomUUID(),{action:'COMMAND_ACCEPTED',clientId:actor.clientId,operationId,op,b,at:Date.now()});return null;});if(old){if(old.state==='SUCCEEDED')return old.result;deny(409,'COMMAND_'+old.state);}}
 const now=Date.now(),attestation=signAttestation({version:1,keyId:this.keyId,tokenHash:actor.tokenHash,clientId:actor.clientId,revision:actor.revision,environment:'PRODUCTION',kind:'SERVICE',method,path,bodyHash:hash(canonical(payload)),operationId,scope,binding:b,issuedAt:now,expiresAt:Math.min(now+30000,actor.expiresAt),nonce:randomUUID()},this.key);
 try{const result=await adapter.execute({actor,token,attestation,method,path,binding:b,payload,operationId,operation:op});if(result===undefined)deny(503,'OWNER_INVALID_RESULT');if(!read)await this.store.transaction(['command:'+commandKey],async tx=>{await tx.put('command',commandKey,{hash:requestHash,state:'SUCCEEDED',operationId,result});await tx.put('audit',randomUUID(),{action:'COMMAND_SUCCEEDED',clientId:actor.clientId,operationId,op,at:Date.now()});});return result;}
 catch(e){if(!read)await this.store.transaction(['command:'+commandKey],async tx=>{await tx.put('command',commandKey,{hash:requestHash,state:'UNCERTAIN',operationId});await tx.put('audit',randomUUID(),{action:'COMMAND_UNCERTAIN',clientId:actor.clientId,operationId,op,at:Date.now()});});throw e;}
 }
}



