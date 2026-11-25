/* Isolated real Next PWA + Playwright from the approved preflight workspace; no real backend/session. */
const {createRequire}=require('node:module'),{spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),app=path.join(root,'apps/web-pwa'),output=path.join(root,'output/playwright/gre-repair');
const origin='http://127.0.0.1:3117';
const pw=createRequire('C:/Users/maxmo/orca/workspaces/FactuEz/codex-programador-preflight-20261102/package.json')('@playwright/test');
const local=createRequire(path.join(app,'package.json'));
for(const directory of [root,app])for(const file of ['.env','.env.local','.env.development','.env.development.local'])assert(!fs.existsSync(path.join(directory,file)),'REFUSED_ENV_FILE');
fs.mkdirSync(output,{recursive:true});
const env={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_API_BASE_URL:origin});
const log=fs.openSync(path.join(output,'server.log'),'w');
const server=spawn(process.execPath,[local.resolve('next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','3117'],{cwd:app,env,windowsHide:true,stdio:['ignore',log,log]});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let browser;
const results=[];
(async()=>{
 for(let i=0;i<90;i++){try{const response=await fetch(origin+'/login');if(response.ok)break;}catch{}if(i===89)throw Error('LOCAL_NEXT_START_TIMEOUT');await pause(1000);}
 browser=await pw.chromium.launch({channel:'chrome',headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const name=viewport.width===390?'mobile':'desktop',context=await browser.newContext({viewport,hasTouch:name==='mobile',acceptDownloads:true,serviceWorkers:'block'});
  const page=await context.newPage(),violations=[],errors=[],requests=[],consoleErrors=[],httpErrors=[];
  let configured=true,failDownload=false,deny=false,cancelExpected=false,releaseDownload;const expectedCancellations=[];
  let downloadGate=Promise.resolve();
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push({text:m.text(),url:m.location().url});});
  page.on('response',r=>{if(r.status()>=400)httpErrors.push({url:r.url(),status:r.status(),expected:r.url()===origin+'/api/v1/setup/sunat/1/BETA/public-certificate'&&r.status()===503});});
  page.on('requestfailed',r=>{if(cancelExpected&&r.url()===origin+'/api/v1/setup/sunat/1/BETA/public-certificate'&&r.failure()?.errorText==='net::ERR_ABORTED')expectedCancellations.push(r.url());else violations.push('requestfailed '+r.url()+' '+r.failure()?.errorText);});
  await context.routeWebSocket('**/*',socket=>{
   const u=new URL(socket.url());
   if(u.origin==='ws://127.0.0.1:3117'&&u.pathname==='/_next/webpack-hmr')return socket.connectToServer();
   if(u.origin==='ws://127.0.0.1:3117'&&u.pathname==='/socket.io/'){
    socket.send('0'+JSON.stringify({sid:'synthetic',upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1000000}));
    socket.onMessage(m=>{if(typeof m==='string'&&m.startsWith('40'))socket.send('40'+JSON.stringify({sid:'synthetic'}));});return;
   }violations.push('unexpected socket '+socket.url());socket.close();
  });
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());requests.push({method:req.method(),path:u.pathname});
   if(u.origin!==origin){violations.push('external '+u.href);return route.abort();}
   const json=value=>route.fulfill({status:200,json:value});
   if(u.pathname==='/api/v1/auth/browser-session/activity')return json({serverNow:Date.now(),idleExpiresAt:Date.now()+1800000});
   if(u.pathname==='/api/v1/auth/browser-session')return json({accessToken:'SYNTHETIC_ACCESS',user:{sub:'00000000-0000-4000-8000-000000000003',username:'synthetic.admin',fullName:'Admin Ficticio',roles:deny?['AUDITOR']:['ADMIN'],permissions:deny?['document.view']:['sunat.configure','document.view'],scope:{kind:'GLOBAL'},exp:Math.floor(Date.now()/1000)+3600},serverNow:Date.now(),idleExpiresAt:Date.now()+1800000});
   if(u.pathname==='/api/v1/documents/catalog/issuance')return json({companies:[{id:1,ruc:'20000000001',legalName:'EMPRESA FICTICIA',environment:'BETA'}],branches:[],emissionPoints:[],products:[],capabilities:{demoData:false,fiscalTransmission:false}});
   if(/^\/api\/v1\/setup\/sunat\/1\/(BETA|PRODUCTION)$/.test(u.pathname))return json({ruc:'20000000001',environment:u.pathname.split('/').at(-1),revision:1,updatedAt:null,certificate:{configured,fingerprint:configured?'a'.repeat(64):null,expiresAt:'2026-12-25T00:00:00Z',selfSigned:false,expired:false,trustAndRucVerified:false},solConfigured:false,greConfigured:false,fiscalTransmission:false});
   if(u.pathname==='/api/v1/setup/sunat/1/BETA/audit')return json({page:1,pageSize:10,total:0,items:[]});
   if(u.pathname==='/api/v1/setup/sunat/1/BETA/readiness')return json({ruc:'20000000001',environment:'BETA',state:'BLOCKED',fiscalTransmission:false,readyForOfficialBeta:false,readyForProduction:false,checkedAt:'2026-11-25T12:00:00Z',checks:[],rules:{profile:'SYNTHETIC',source:{publishedVersion:'fixture'},coverage:[]}});
   if(u.pathname==='/api/v1/setup/sunat/1/BETA/public-certificate'){
    assert.equal(req.method(),'GET');assert.equal(req.headers().accept,'application/pkix-cert');assert.equal(req.headers().authorization,'Bearer SYNTHETIC_ACCESS');
    await downloadGate;
    if(failDownload)return route.fulfill({status:503,json:{message:'Fallo inducido de descarga'}});
    return route.fulfill({status:200,headers:{'content-type':'application/pkix-cert','cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':'attachment; filename="20000000001-BETA-publico.cer"'},body:fs.readFileSync(path.join(root,'output/gre-repair/synthetic-public.cer'))});
   }
   if(!u.pathname.startsWith('/api/')&&(req.isNavigationRequest()||u.pathname.startsWith('/_next/')||u.pathname.startsWith('/brand/')||['/favicon.ico','/manifest.webmanifest','/sw.js'].includes(u.pathname)))return route.continue();
   violations.push('unmocked '+req.method()+' '+u.href);return route.abort();
  });
  async function open(){await page.goto(origin+'/sunat-settings');await page.getByRole('combobox',{name:'Emisor RUC activo'}).click();await page.getByRole('option',{name:/20000000001/}).click();}
  try{
   await open();const button=page.getByRole('button',{name:/Descargar certificado p/});await pw.expect(button).toBeVisible();
   await page.screenshot({path:path.join(output,name+'-configured.png'),fullPage:true});
   downloadGate=new Promise(r=>releaseDownload=r);const downloadEvent=page.waitForEvent('download');await button.click();
   await pw.expect(page.getByRole('button',{name:/Descargando certificado p/})).toBeDisabled();
   await page.screenshot({path:path.join(output,name+'-loading.png'),fullPage:true});releaseDownload();
   const download=await downloadEvent;assert.equal(download.suggestedFilename(),'20000000001-BETA-publico.cer');await download.saveAs(path.join(output,name+'-public.cer'));
   assert(fs.readFileSync(path.join(output,name+'-public.cer')).equals(fs.readFileSync(path.join(root,'output/gre-repair/synthetic-public.cer'))));
   // A company/context change aborts a pending DER request, avoiding a stale/mislabelled download.
   downloadGate=new Promise(r=>releaseDownload=r);cancelExpected=true;let staleDownloads=0;const onStale=()=>staleDownloads++;page.on('download',onStale);
   await page.getByRole('button',{name:/Descargar certificado p/}).click();await pw.expect(page.getByRole('button',{name:/Descargando certificado p/})).toBeDisabled();
   await page.getByRole('combobox',{name:'Emisor RUC activo'}).click();await page.getByRole('option',{name:'Consolidado (todo el alcance)'}).click();
   await pw.expect(page.getByRole('button',{name:/Descargando certificado p/})).toHaveCount(0);releaseDownload();await pause(250);assert.equal(staleDownloads,0);page.off('download',onStale);
   await page.screenshot({path:path.join(output,name+'-context-cancelled.png'),fullPage:true});await open();cancelExpected=false;
   downloadGate=Promise.resolve();failDownload=true;await page.getByRole('button',{name:/Descargar certificado p/}).click();
   await pw.expect(page.getByRole('alert').filter({hasText:/No se pudo descargar/})).toBeVisible();
   await page.screenshot({path:path.join(output,name+'-error.png'),fullPage:true});
   const overflow=await page.evaluate(()=>Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)-innerWidth);assert(overflow<=0,'HORIZONTAL_OVERFLOW');
   configured=false;await open();await pw.expect(page.getByText('Sin certificado',{exact:true})).toBeVisible();await pw.expect(page.getByRole('button',{name:/Descargar certificado p/})).toHaveCount(0);
   await page.screenshot({path:path.join(output,name+'-empty.png'),fullPage:true});
   deny=true;await page.reload();await pw.expect(page.getByText(/Esta configuraci.n requiere un administrador general|No tiene permisos|No tiene acceso|Acceso restringido|Acceso no autorizado/)).toBeVisible();await pw.expect(page.getByRole('button',{name:/Descargar certificado p/})).toHaveCount(0);
   await page.screenshot({path:path.join(output,name+'-permission.png'),fullPage:true});
   assert.deepEqual(errors,[]);assert.deepEqual(violations,[]);assert.deepEqual(httpErrors.filter(e=>!e.expected),[]);
   const unexpectedConsole=consoleErrors.filter(e=>!httpErrors.some(h=>h.expected&&h.url===e.url&&e.text.includes('503')));assert.deepEqual(unexpectedConsole,[]);
   results.push({name,viewport,overflow,errors,violations,httpErrors,consoleErrors,requests,expectedCancellations,status:'passed'});
  }catch(error){await page.screenshot({path:path.join(output,name+'-failure.png'),fullPage:true});results.push({name,status:'failed',errors,violations,httpErrors,consoleErrors,requests,body:await page.locator('body').innerText()});throw error;}finally{releaseDownload?.();await context.tracing.stop({path:path.join(output,name+'-trace.zip')});await context.close();}
 }
})().catch(e=>{process.exitCode=1;results.push({status:'failed',error:e.stack});console.error(e.message);}).finally(async()=>{
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));await browser?.close();
 if(process.platform==='win32')spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill();
 fs.closeSync(log);console.log(JSON.stringify(results.map(r=>({name:r.name,status:r.status,error:r.error})),null,2));
});
