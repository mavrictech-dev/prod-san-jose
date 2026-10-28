import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {generateKeyPairSync,createPublicKey,randomBytes,randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {PasswordService} from '../../services/identity-service/src/application/password.service';
import {AuthService} from '../../services/identity-service/src/application/auth.service';
import {OnpremVerifiedAdminAuthority,onpremSessionCookie} from '../../services/identity-service/src/b2b/onprem-admin-authority';
import {MemoryB2bStore,binding} from '../b2b-identity.fixture';
import {b2bReadonlyScopes} from '../../packages/service-access/src/b2b-readonly-owner';
import {B2bIdentity} from '../../services/identity-service/src/b2b/service';
import {B2bTokenCodec} from '../../services/identity-service/src/b2b/token';
import {OnpremAdminApplications} from '../../services/identity-service/src/b2b/onprem-admin-service';
export const origin='https://pwa.synthetic.invalid',password='Synthetic-only-current-password-31!';
/** Test-only Identity row and browser-session directory. Real PasswordService,
 * AuthService RSA signing/verifying/assertActive and admin authority run intact.
 * No network/database credentials or user data are read. */
export async function onpremFixture(){
 const root=mkdtempSync(join(tmpdir(),'factuez-onprem-admin-')),pair=generateKeyPairSync('rsa',{modulusLength:2048});
 const humanPrivate=Buffer.from(pair.privateKey.export({type:'pkcs8',format:'pem'})),humanPublic=Buffer.from(pair.publicKey.export({type:'spki',format:'pem'}));
 writeFileSync(join(root,'human.key'),humanPrivate,{mode:0o600});writeFileSync(join(root,'human.pem'),humanPublic,{mode:0o600});
 vi.stubEnv('JWT_PRIVATE_KEY_FILE',join(root,'human.key'));vi.stubEnv('JWT_PUBLIC_KEY_FILE',join(root,'human.pem'));
 vi.stubEnv('JWT_ISSUER','synthetic-onprem-human');vi.stubEnv('JWT_AUDIENCE','factuez-services');
 const passwords=new PasswordService(),userId=randomUUID(),browserId=randomBytes(32).toString('hex');
 const row:any={id:userId,username:'synthetic-admin',fullName:'SYNTHETIC ADMIN',active:true,authVersion:1,passwordHash:await passwords.hash(password),
  roles:[{role:{code:'ADMIN',active:true,permissions:['SETUP_MANAGE','USER_MANAGE','ROLE_MANAGE','DOCUMENT_VIEW'].map(code=>({permission:{code}}))}}],
  branches:[],emissionPoints:[],series:[]};
 let browserActive=true,now=Date.now();
 const db:any={user:{findUnique:vi.fn(async({where}:any)=>where.id===userId?structuredClone(row):null)}};
 const sessions={get:vi.fn(async(id:string)=>{if(!browserActive||id!==browserId)throw Object.assign(new Error('SESSION_REVOKED'),{getStatus:()=>401});return {userId,authVersion:row.authVersion,lastActivityAt:Date.now()};})};
 const auth=new AuthService(db,passwords,sessions as any,{effective:async()=>[]} as any);
 const access=await auth.browserAccess(userId,row.authVersion,browserId);
 const store=new MemoryB2bStore(),catalogue={validate:vi.fn(async(values:any[])=>{if(values.some(v=>JSON.stringify(v)!==JSON.stringify(binding)))throw Error('INACTIVE_BINDING');})};
 const authority=new OnpremVerifiedAdminAuthority({db,auth,passwords,store},[origin],()=>now);
 const dedicated=generateKeyPairSync('rsa',{modulusLength:2048}),legacy=generateKeyPairSync('rsa',{modulusLength:2048});
 const codec=new B2bTokenCodec(Buffer.from(dedicated.privateKey.export({type:'pkcs8',format:'pem'})),'https://onprem.synthetic.invalid',
  ()=>Math.floor(now/1000),{human:humanPublic,integration:Buffer.from(legacy.publicKey.export({type:'spki',format:'pem'})),tls:Buffer.from(createPublicKey(humanPrivate).export({type:'spki',format:'pem'}))});
 const core=new B2bIdentity(store,codec,randomBytes(32),authority,catalogue,null,()=>now,[...b2bReadonlyScopes]);
 const applications=new OnpremAdminApplications(core,authority);
 const req:any={headers:{origin,'sec-fetch-site':'same-origin','x-factuez-b2b-admin':'ONPREM',authorization:'Bearer '+access.accessToken}};
 const establish=async()=>{
  const result=await authority.status(req);
  if(result.cookie)req.headers.cookie=onpremSessionCookie+'='+result.cookie;
  req.headers['x-factuez-csrf']=result.state.csrfToken;
  return result.state;
 };
 return {root,row,db,auth,passwords,authority,store,catalogue,core,applications,req,browserId,userId,humanPublic,humanPrivate,
  async establish(){return establish();},async verify(){await establish();return authority.reauthenticate(req,{password});},
  revokeBrowser(){browserActive=false;},advance(ms:number){now+=ms;},
  async refresh(){const access=await auth.browserAccess(userId,row.authVersion,browserId);req.headers.authorization='Bearer '+access.accessToken;},
  close(){authority.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('factuez-onprem-admin-'))throw Error('OUTSIDE_SYNTHETIC_ROOT');rmSync(root,{recursive:true,force:true});}
 };
}
