'use strict';
// Actual shipping Kong routes forwarding only to a disposable loopback Billing host.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
async function withSeriesKong({root,output,port,token},work){
 const run=randomUUID(),dir=fs.mkdtempSync(path.join(output,'.kong-')),image='kong:3.9.3',checks=[],sockets=new Set();let container,digest,bridge;
 const docker=(args,input='')=>{const r=spawnSync('docker',['--context','desktop-linux',...args],{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});assert.equal(r.status,0,'SYNTHETIC_SERIES_KONG_COMMAND_FAILED');return r.stdout.trim();};
 try{
  const net=require('node:net');bridge=net.createServer(socket=>{const target=net.connect(port,'127.0.0.1');sockets.add(socket);sockets.add(target);socket.on('error',()=>target.destroy());target.on('error',()=>socket.destroy());socket.on('close',()=>{sockets.delete(socket);target.destroy();});target.on('close',()=>{sockets.delete(target);socket.destroy();});socket.pipe(target).pipe(socket);});
  // Docker Desktop cannot reach a Windows loopback bind: this ephemeral bridge
  // forwards only to our synthetic JWT-protected host, never an installed service.
  await new Promise(r=>bridge.listen(0,'0.0.0.0',r));
  digest=docker(['image','inspect',image,'--format','{{.Id}}']);const config=JSON.parse(fs.readFileSync(path.join(root,'infra/deployment/core-production/kong.yml'),'utf8'));
  for(const service of config.services)service.url=service.name==='billing-service'?'http://host.docker.internal:'+bridge.address().port:'http://127.0.0.1:1';
  fs.writeFileSync(path.join(dir,'kong.yml'),JSON.stringify(config));
  container=docker(['run','--rm','--pull','never','-d','--read-only','--tmpfs','/tmp:rw,size=134217728,mode=1777','--memory','512m','--cpus','1','--label','factuez.gre.series.kong='+run,'--mount','type=bind,source='+dir+',target=/synthetic,readonly','-e','KONG_DATABASE=off','-e','KONG_ADMIN_LISTEN=off','-e','KONG_PROXY_LISTEN=127.0.0.1:8000','-e','KONG_STATUS_LISTEN=127.0.0.1:8100','-e','KONG_DECLARATIVE_CONFIG=/synthetic/kong.yml','-e','KONG_PREFIX=/tmp/kong','-e','KONG_NGINX_WORKER_PROCESSES=1','-e','KONG_PROXY_ACCESS_LOG=off',image]);
  assert.match(container,/^[a-f0-9]{64}$/);const isolation=JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]));assert.equal(Object.keys(isolation.PortBindings??{}).length,0);
  let healthy=false;for(let i=0;i<60;i++){const r=spawnSync('docker',['--context','desktop-linux','exec',container,'kong','health'],{encoding:'utf8',windowsHide:true,timeout:3000});if(r.status===0){healthy=true;break;}await new Promise(r=>setTimeout(r,200));}assert.ok(healthy,'SYNTHETIC_SERIES_KONG_HEALTH');
  const request=async(url,method='GET',body,auth=token)=>{
   assert.ok(url.startsWith('/api/v1/production-guides'));
   const code="local j=require('cjson');local h=require('resty.http').new();h:set_timeout(15000);local v=j.decode(io.read('*a'));local r,e=h:request_uri('http://127.0.0.1:8000'..v.path,{method=v.method,body=v.body,headers={['Content-Type']='application/json',['Authorization']='Bearer '..v.auth}});assert(r,'SYNTHETIC_UPSTREAM_FAILED');print(j.encode({status=r.status,body=r.body}));";
   // Auth exists only in stdin to this isolated test; it is never printed or written.
   const text=await new Promise((resolve,reject)=>{const child=spawn('docker',['--context','desktop-linux','exec','-i',container,'resty','-e',code],{windowsHide:true,stdio:['pipe','pipe','ignore']});let data='';const timer=setTimeout(()=>{child.kill();reject(Error('SYNTHETIC_KONG_REQUEST_TIMEOUT'));},30000);child.stdout.on('data',b=>{data+=b.toString();if(data.length>2*1024*1024)child.kill();});child.on('error',()=>{clearTimeout(timer);reject(Error('SYNTHETIC_KONG_REQUEST_FAILED'));});child.on('close',status=>{clearTimeout(timer);status===0?resolve(data.trim()):reject(Error('SYNTHETIC_KONG_REQUEST_FAILED'));});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({path:url,method,body:body===undefined?undefined:JSON.stringify(body),auth}));});
   const answer=JSON.parse(text);
   const parsed=JSON.parse(answer.body);checks.push({method,path:url,status:answer.status,code:parsed.code});return {status:answer.status,json:async()=>parsed};
  };
  await work(request);
 }finally{
  fs.writeFileSync(path.join(output,'kong-results.json'),JSON.stringify({synthetic:true,image,digest,publishedPorts:0,shippingRoutesUnchanged:true,checks},null,2)+'\n');
  if(container){const labels=JSON.parse(docker(['inspect','--format','{{json .Config.Labels}}',container]));assert.equal(labels['factuez.gre.series.kong'],run);docker(['stop','--time','2',container]);}
  for(const socket of sockets)socket.destroy();if(bridge)await new Promise(r=>bridge.close(r));
  assert.ok(path.resolve(dir).startsWith(path.resolve(output)+path.sep));fs.rmSync(dir,{recursive:true,force:true});
 }
}
module.exports={withSeriesKong};
