import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {RedisAdminBffStore,adminBffHash} from '../services/b2b-api-service/src/admin-bff-store';
it('real NEW network-none tmpfs Redis: sealed data, one-use Lua, TTL, quota and revocation',async()=>{
 if(process.env.FACTUEZ_ADMIN_BFF_NEW_REDIS_ONLY!=='NEW_NETWORK_NONE_TMPFS_ONLY')throw new Error('EXPLICIT_NEW_REDIS_RUNNER_REQUIRED');
 const run=randomUUID(),label='factuez.b2b.admin-bff.test';let container:string|undefined;
 const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
 try{
  docker(['image','inspect','redis:7-alpine']);container=docker(['run','--pull','never','--rm','-d','--name','factuez-admin-bff-'+run.slice(0,8),'--label',label+'='+run,'--network','none','--memory','128m','--cpus','1','--tmpfs','/data:rw','redis:7-alpine','redis-server','--save','','--appendonly','no']);
  expect(container).toMatch(/^[a-f0-9]{64}$/);const config=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]));expect(config.NetworkMode).toBe('none');expect(config.PortBindings??{}).toEqual({});expect(config.Tmpfs['/data']).toBe('rw');
  let ready=false;for(let i=0;i<30;i++){try{if(docker(['exec',container,'redis-cli','--raw','PING'])==='PONG'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}expect(ready).toBe(true);
  const command=(...args:string[])=>docker(['exec',container!,'redis-cli','--raw',...args]);
  const client={get:async(k:string)=>command('GET',k)||null,set:async(k:string,v:string,px:'PX',ttl:number,nx:'NX')=>command('SET',k,v,px,String(ttl),nx)||null,del:async(k:string)=>Number(command('DEL',k)),eval:async(s:string,n:number,...args:string[])=>Number(command('EVAL',s,String(n),...args))};
  const store=new RedisAdminBffStore(client,randomBytes(32),'owned-redis-test'),opaque=()=>randomBytes(32).toString('base64url');
  const state=opaque(),browser=opaque();await store.putFlow(state,{browserHash:adminBffHash(browser),nonce:opaque(),verifier:opaque(),expiresAt:Date.now()+120000});
  expect(await store.takeFlow(state,opaque())).toBeNull();const taken=await Promise.all([store.takeFlow(state,browser),store.takeFlow(state,browser)]);expect(taken.filter(Boolean)).toHaveLength(1);expect(await store.takeFlow(state,browser)).toBeNull();
  const id=opaque(),session={accessToken:'synthetic-private-oidc-access',profile:{issuer:'https://idp.invalid',subject:'synthetic-human',clientId:'synthetic-web',expiresAt:Date.now()+200000,authTime:Date.now(),acr:'synthetic-mfa',amr:['mfa']},csrfToken:opaque(),revision:opaque(),expiresAt:Date.now()+200000};
  await store.putSession(id,session);const key='factuez:admin-bff:owned-redis-test:session:'+adminBffHash(id),sealed=command('GET',key);expect(sealed).not.toContain(session.accessToken);expect(sealed).not.toContain(session.csrfToken);expect(Number(command('PTTL',key))).toBeGreaterThan(100000);expect(await store.getSession(id)).toEqual(session);
  const copiedId=opaque(),copied='factuez:admin-bff:owned-redis-test:session:'+adminBffHash(copiedId);command('SET',copied,sealed,'PX','10000');await expect(store.getSession(copiedId)).rejects.toThrow();
  const bucket=adminBffHash('one-private-edge');expect(await store.admit(bucket,2,60000)).toBe(true);expect(await store.admit(bucket,2,60000)).toBe(true);expect(await store.admit(bucket,2,60000)).toBe(false);
  command('PEXPIRE',key,'5');await new Promise(r=>setTimeout(r,20));expect(await store.getSession(id)).toBeNull();
  await store.putSession(id,{...session,expiresAt:Date.now()+10000});await store.deleteSession(id);expect(await store.getSession(id)).toBeNull();
 }finally{if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));expect(labels[label]).toBe(run);docker(['stop','--time','1',container]);}}
},120000);
