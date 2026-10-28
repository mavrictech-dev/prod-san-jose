// Rehearse the reviewed UID/secret contract on a NEW, network-isolated tmpfs Redis.
'use strict';
const {spawnSync}=require('node:child_process');const {randomUUID}=require('node:crypto');
const {readFileSync}=require('node:fs');
function docker(args){const r=spawnSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:65536});if(r.error||r.status!==0)throw Error('ISOLATED_REDIS_REHEARSAL_FAILED');return r.stdout.trim();}
try{
 if(process.argv.slice(2).join(' ')!=='--isolated-synthetic-only')throw Error('ISOLATED_SYNTHETIC_CONFIRMATION_REQUIRED');
 const endpoint=docker(['context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}']);if(!endpoint.startsWith('npipe:')||!endpoint.toLowerCase().includes('dockerdesktoplinuxengine'))throw Error('LOCAL_DESKTOP_ONLY');
 const image=docker(['inspect','factuez-stage2-qa-redis-1','--format','{{.Config.Image}}']);
 const model=JSON.parse(readFileSync('infra/deployment/core-production/docker-compose.yml','utf8'));if(model.services.redis.user!=='1000:1000')throw Error('COMPOSE_UID_CONTRACT_CHANGED');
 const result=docker(['run','--rm','--pull','never','--network','none','--user','1000:1000','--read-only','--memory','134217728','--memory-swap','134217728','--cpus','0.5','--pids-limit','32',
 '--label','factuez.synthetic.core-redis-user=true','--name','factuez-synthetic-redis-user-'+randomUUID(),
 '--tmpfs','/data:rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700',
 '--entrypoint','sh',image,'-ec',
 'test "$(id -u)" = 1000; umask 077; printf %s SYNTHETIC-ONLY-PASSWORD > /tmp/redis_password; printf "user default on >SYNTHETIC-ONLY-PASSWORD ~* &* +@all\\n" > /tmp/redis_acl; test "$(stat -c %a /tmp/redis_password)" = 600; redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no --aclfile /tmp/redis_acl --maxmemory 33554432 --maxmemory-policy noeviction --daemonize yes --logfile /tmp/redis.log --pidfile /tmp/redis.pid; trap \'REDISCLI_AUTH="$(cat /tmp/redis_password)" redis-cli --no-auth-warning shutdown nosave >/dev/null 2>&1 || true\' EXIT; REDISCLI_AUTH="$(cat /tmp/redis_password)" redis-cli --no-auth-warning ping | grep -qx PONG; printf PASS']);
 if(result!=='PASS')throw Error('REDIS_READINESS_UNCONFIRMED');
 console.log(JSON.stringify({result:'PASS',user:'1000:1000',secretMode:'0600',network:'none',publishedPorts:0,persistentMounts:0,existingDataTouched:false}));
}catch(e){console.error(e.message);process.exitCode=1;}
