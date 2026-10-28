import {deny,verifyProductionAttestation,type ProductionActor,type ProductionBinding,type ProductionIntrospection,type ProductionStore} from '@factuez/service-access/dist/b2b-production-contract';
import {ProductionPrivateTransport} from '@factuez/service-access/dist/b2b-production-transport';
import {productionOperations,type ProductionOperation,type ProductionOwnerAdapter,type ProductionOwnerRequest} from './production-facade';
export interface ProductionNativeEnvelope {binding:ProductionBinding;payload:unknown;operationId:string;attestation:string}
/** One explicit private route per operation. This never calls a legacy human-only endpoint. */
export class ProductionOwnerHttpAdapter implements ProductionOwnerAdapter {
 constructor(private readonly transport:ProductionPrivateTransport,private readonly operation:ProductionOperation){}
 async execute(r:ProductionOwnerRequest){if(r.operation!==this.operation)deny(503,'OWNER_OPERATION_MISMATCH');const response=await this.transport.post('/internal/b2b/production/commands/'+this.operation,{binding:r.binding,payload:r.payload,operationId:r.operationId,attestation:r.attestation},'Bearer '+r.token);if(response.status<200||response.status>=300)deny(response.status===403?403:response.status===409?409:503,response.status===403?'OWNER_SCOPE_DENIED':response.status===409?'OWNER_CONFLICT':'OWNER_UNAVAILABLE');return response.body;}
}
export interface ProductionNativeCommand {
 actor:ProductionActor;binding:ProductionBinding;payload:unknown;operationId:string;operation:ProductionOperation;authorization:string;
}
/** Called by a new private native guard AFTER it checks its TLS peer and extracts the bearer.
 * The native owner must resolve actual RUC/branch/point/series from DB, enforce native privileges,
 * PRODUCTION fiscal admission and dedupe operationId atomically with its native write.
 * No AccessScope GLOBAL, userId, sub, JWT exchange, or arithmetic is fabricated here. */
export async function admitProductionNativeCommand(operation:ProductionOperation,body:unknown,token:string,privatePeerVerified:boolean,keys:ReadonlyMap<string,Buffer>,identity:ProductionIntrospection,store:ProductionStore):Promise<ProductionNativeCommand>{
 if(!Object.hasOwn(productionOperations,operation))deny(404,'OPERATION_NOT_FOUND');const b=body as ProductionNativeEnvelope;
 if(!b||Object.keys(b).sort().join(',')!=='attestation,binding,operationId,payload'||typeof b.operationId!=='string'||!/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(b.operationId))deny(400,'INVALID_OWNER_ENVELOPE');
 const actor=await verifyProductionAttestation({attestation:b.attestation,token,method:'POST',path:'/b2b/production/v1/operations/'+operation,body:b.payload,scope:productionOperations[operation],binding:b.binding,operationId:b.operationId,privatePeerVerified},keys,identity,store);
 return {actor,binding:b.binding,payload:b.payload,operationId:b.operationId,operation,authorization:'Bearer '+token};
}

import type {IncomingMessage,ServerResponse} from 'node:http';
import {productionBearer,productionBody,productionFailure,productionJson,productionPeer,requireProductionProfile} from '@factuez/service-access/dist/b2b-production-http';
/** Main supplies native admission explicitly. This is separate from the existing human JWT guard. */
export interface ProductionNativeProvider {
 authorize(command:ProductionNativeCommand):Promise<void>;
 execute(command:ProductionNativeCommand):Promise<unknown>;
}
export function productionNativeRouter(profile:string,providers:Partial<Record<ProductionOperation,ProductionNativeProvider>>,peers:readonly string[],keys:ReadonlyMap<string,Buffer>,identity:ProductionIntrospection,store:ProductionStore,administration:Partial<Record<ProductionOperation,boolean>>={}){requireProductionProfile(profile);if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw Error('PRODUCTION_PRIVATE_PEERS_REQUIRED');const owners={...providers};return async(req:IncomingMessage,res:ServerResponse)=>{try{productionPeer(req,peers);const url=new URL(req.url??'/','https://private.invalid'),match=/^\/internal\/b2b\/production\/commands\/([A-Za-z0-9]+)$/.exec(url.pathname);if(req.method!=='POST'||url.search||!match||!Object.hasOwn(productionOperations,match[1]))deny(404,'ROUTE_NOT_FOUND');const operation=match[1] as ProductionOperation,owner=owners[operation];if(!owner||/^(masters|users)/.test(operation)&&administration[operation]!==true)deny(503,'OWNER_UNRESOLVED');const command=await admitProductionNativeCommand(operation,await productionBody(req),productionBearer(req),true,keys,identity,store);await owner.authorize(command);const result=await owner.execute(command);if(result===undefined)deny(503,'OWNER_INVALID_RESULT');productionJson(res,200,result);}catch(e){productionFailure(res,e);}};}


