import {createPublicKey,generateKeyPairSync,randomBytes} from 'node:crypto';
import {B2bTokenCodec} from '../services/identity-service/src/b2b/token';
import {B2bIdentity} from '../services/identity-service/src/b2b/service';
import {MemoryB2bStore,pem,others,input,ctx,basic,id} from './b2b-identity.fixture';
import {fail} from '../services/identity-service/src/b2b/model';
const next=generateKeyPairSync('rsa',{modulusLength:2048});
export const nextPem=Buffer.from(next.privateKey.export({format:'pem',type:'pkcs8'}));
export const previousPublic=Buffer.from(createPublicKey(pem).export({format:'pem',type:'spki'}));
export function keyRotationFixture(){
 let time=1800000000;const store=new MemoryB2bStore(),pepper=randomBytes(32),issuer='https://b2b.identity.invalid';
 const authority={verify:async(token:string)=>{if(token!=='human-step-up')return fail(403,'STEP_UP_REQUIRED');return {id:id(9),stepUpVerified:true as const};}},catalogue={validate:async()=>{}};
 const codec=new B2bTokenCodec(pem,issuer,()=>time,others);
 const compose=(codec:B2bTokenCodec)=>new B2bIdentity(store,codec,pepper,authority,catalogue,null,()=>time*1000);
 const old=compose(codec),rotated=()=>new B2bTokenCodec(nextPem,issuer,()=>time,others,{previous:{publicKey:Buffer.from(previousPublic),cutoverAt:time}});
 return {store,old,codec,issuer,compose,rotated,now:()=>time,advance:(s:number)=>{time+=s;},setTime:(s:number)=>{time=s;}};
}
export async function issuedRotation(){
 const f=keyRotationFixture(),made=await f.old.create('human-step-up',input(),ctx());
 const token=await f.old.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read b2b:catalog:read'},ctx());
 return {...f,made,token:token.access_token!};
}
