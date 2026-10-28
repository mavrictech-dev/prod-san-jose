import {randomBytes} from 'node:crypto';
import {vi} from 'vitest';
import {B2bSecurityError} from '../../packages/contracts/src/b2b-security';
import {AdminSessionBff} from '../../services/b2b-api-service/src/admin-bff-core';
import {RedisAdminBffStore,adminBffHash,type AdminBffRedis} from '../../services/b2b-api-service/src/admin-bff-store';
import {adminFixture} from '../b2b-integration-admin.fixture';
/** Explicit Redis command double. The isolated Redis runner validates the Lua scripts separately. */
export class AdminRedisDouble implements AdminBffRedis {
 values=new Map<string,{value:string;until:number}>();
 constructor(private readonly now:()=>number){}
 async get(key:string){const v=this.values.get(key);if(v&&v.until>this.now())return v.value;this.values.delete(key);return null;}
 async set(key:string,value:string,_px:'PX',ttl:number,_nx:'NX'){if(await this.get(key)!==null)return null;this.values.set(key,{value,until:this.now()+ttl});return 'OK';}
 async del(key:string){return this.values.delete(key)?1:0;}
 async eval(script:string,_count:number,key:string,...args:string[]){if(script.includes("'INCR'")){const old=await this.get(key),n=Number(old??0)+1;this.values.set(key,{value:String(n),until:old===null?this.now()+Number(args[0]):this.values.get(key)!.until});return n<=Number(args[1])?1:0;}if(await this.get(key)!==args[0])return 0;return this.del(key);}
}
export function adminBffFixture(origin='https://factuez.test',enabled=true,redisOverride?:AdminBffRedis){
 const control={time:Date.now(),active:true,nonce:'',challenge:'',fail:false,drift:false},now=()=>control.time;
 const redis=redisOverride??new AdminRedisDouble(now),store=new RedisAdminBffStore(redis,randomBytes(32),'synthetic-test',now);
 const owner=adminFixture();const token='synthetic-verified-admin-access';
 owner.admin.verify.mockImplementation(async proof=>{if(proof!==token||!owner.state.active||!owner.state.stepUp)throw new B2bSecurityError(403,'STEP_UP_REQUIRED');return {id:owner.state.actorId,stepUpVerified:true};});
 const profile=()=>({issuer:'https://synthetic-idp.invalid',subject:control.drift?'changed-subject':'explicit-admin-link',clientId:'synthetic-admin-web',expiresAt:control.time+240000,authTime:control.time,acr:'synthetic-mfa',amr:['pwd','mfa']});
 const initial=profile();
 const provider={authorize:vi.fn((v:{state:string;nonce:string;codeChallenge:string})=>{control.nonce=v.nonce;control.challenge=v.codeChallenge;return 'https://synthetic-idp.invalid/authorize?'+new URLSearchParams(v);}),
  exchange:vi.fn(async(v:{code:string;verifier:string;nonce:string})=>{if(control.fail)throw new Error('PRIVATE_CLIENT_SECRET');if(v.code!=='synthetic-valid-code'||v.nonce!==control.nonce||Buffer.from(adminBffHash(v.verifier),'hex').toString('base64url')!==control.challenge)throw new B2bSecurityError(401,'INVALID_TOKEN');return {accessToken:token,profile:{...initial}};}),
  verify:vi.fn(async()=>{if(control.fail)throw new Error('PRIVATE_ACCESS_TOKEN');if(!control.active)throw new B2bSecurityError(401,'INVALID_TOKEN');return {...initial,...(control.drift?{subject:'changed-subject'}:{})};})};
 const core=new AdminSessionBff({origin,enabled,provider,store,facade:owner.facade,now});
 async function login(){const start=await core.start(),state=new URL(start.authorizeUrl).searchParams.get('state')!;return {...start,...await core.callback('synthetic-valid-code',state,start.browserCookie)};}
 return {control,now,redis,store,owner,provider,core,login,token};
}
