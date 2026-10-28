import {execFile} from 'node:child_process';
import {realpath} from 'node:fs/promises';
import {posix} from 'node:path';
import type {B2bContainerObservation} from './b2b-offline-verifier';
// Deliberately select metadata only; never inspect Config.Env, Args, keys or logs.
const format='{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},"oomKilled":{{json .State.OOMKilled}},"restartCount":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"deploymentId":{{json (index .Config.Labels "factuez.deployment-id")}},"instanceId":{{json (index .Config.Labels "factuez.instance-id")}},"mounts":{{json .Mounts}}}';
export interface B2bDockerMetadataIo {run(args:string[]):Promise<string>;canonical(path:string):Promise<string>}
/** No mutation, socket mount or startup. A privileged host operator runs these
 * bounded metadata commands explicitly on the Ubuntu host. */
export function localB2bDockerMetadataIo():B2bDockerMetadataIo {
 if(process.platform!=='linux')throw Error('HOST_DOCKER_OBSERVER_REQUIRES_LINUX');
 return {canonical:realpath,run:args=>new Promise((resolve,reject)=>{
  execFile('docker',['--host','unix:///var/run/docker.sock',...args],{shell:false,timeout:1500,maxBuffer:2*1024*1024,encoding:'utf8'},(error,stdout)=>{
   if(error)reject(Error('DOCKER_METADATA_UNAVAILABLE'));else resolve(stdout);
  });
 })};
}
export class DockerB2bMetadataObserver {
 constructor(private readonly io:B2bDockerMetadataIo){}
 async inspect():Promise<B2bContainerObservation[]>{
  try{
   const raw=await this.io.run(['container','ls','--all','--no-trunc','--format','{{.ID}}']);
   if(Buffer.byteLength(raw)>65536)throw Error();const ids=raw.trim().split(/\r?\n/).filter(Boolean);
   if(!ids.length||ids.length>512||new Set(ids).size!==ids.length||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw Error();
   const details=await this.io.run(['container','inspect','--format',format,...ids]);if(Buffer.byteLength(details)>2*1024*1024)throw Error();
   const rows=details.trim().split(/\r?\n/).map(line=>JSON.parse(line));
   if(rows.length!==ids.length||new Set(rows.map(r=>r.id)).size!==ids.length||rows.some(r=>!ids.includes(r.id)||!Array.isArray(r.mounts)))throw Error();
   const result:B2bContainerObservation[]=[];
   for(const row of rows){
    if(Object.keys(row).sort().join(',')!==['id','deploymentId','instanceId','project','running','paused','restarting','dead','oomKilled','restartCount','startedAt','mounts'].sort().join(','))throw Error();
    const mounts:B2bContainerObservation['mounts']=[];
    for(const mount of row.mounts){
     if(!['bind','volume','tmpfs'].includes(mount.Type)||typeof mount.RW!=='boolean')throw Error();
     if(mount.Type==='tmpfs')continue;
     if(typeof mount.Source!=='string'||!mount.Source.startsWith('/')||posix.normalize(mount.Source)!==mount.Source)throw Error();
     const source=await this.io.canonical(mount.Source);
     if(!source.startsWith('/')||posix.normalize(source)!==source)throw Error();mounts.push({source,readOnly:!mount.RW});
    }
    result.push({...row,deploymentId:row.deploymentId||null,instanceId:row.instanceId||null,project:row.project||null,mounts});
   }
   return result;
  }catch{throw Error('DOCKER_OFFLINE_OBSERVATION_UNAVAILABLE');}
 }
}
