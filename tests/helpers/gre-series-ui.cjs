'use strict';
// Actual PWA/Chrome with series requests forwarded through real Kong -> Billing -> PG.
// Session/catalog presentation is synthetic; browser never receives the harness JWT.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process'),{createRequire}=require('node:module');
async function seriesUi({root,output,request,id}){
 const app=path.join(root,'apps/web-pwa'),local=createRequire(path.join(app,'package.json'));
 const dep=process.env.FACTUEZ_PLAYWRIGHT_PACKAGE_JSON;assert.ok(dep&&path.isAbsolute(dep),'EXISTING_PLAYWRIGHT_DEPENDENCY_REQUIRED');
 const loader=createRequire(dep);assert.equal(loader('@playwright/test/package.json').version,'1.64.1');const pw=loader('@playwright/test');
 const ui=path.join(output,'ui');fs.mkdirSync(ui,{recursive:true});
 for(const dir of [root,app])for(const name of ['.env','.env.local','.env.development','.env.development.local'])assert.ok(!fs.existsSync(path.join(dir,name)),'REFUSED_ENV_FILE');
 const net=require('node:net'),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
 const env={};for(const k of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];Object.assign(env,{NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_API_BASE_URL:origin});
 const log=fs.openSync(path.join(ui,'server.log'),'w'),server=spawn(process.execPath,[local.resolve('next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',String(port)],{cwd:app,env,windowsHide:true,stdio:['ignore',log,log]});let browser;const results=[];
 try{
  let healthy=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/login')).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert.ok(healthy,'SERIES_UI_START_FAILED');
  browser=await pw.chromium.launch({channel:'chrome',headless:true});
  for(const [index,viewport]of [{width:1440,height:900},{width:390,height:844}].entries()){
   const name=index?'mobile':'desktop',context=await browser.newContext({viewport,serviceWorkers:'block'}),page=await context.newPage();
   const posts=[],network=[],requestFailures=[],consoleErrors=[],pageErrors=[],unexpected=[],checks=[];let failVerification=false,injectInvalid=false,grantFixture=false,localSelectionMissing=false,grantFault;
   page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push({text:m.text(),url:m.location().url});});
   page.on('response',r=>{if(r.status()>=400)network.push({url:r.url(),status:r.status(),expected:r.url().startsWith(origin+'/api/v1/production-guides')&&([400,409].includes(r.status())||r.status()===500&&new URL(r.url()).pathname.endsWith('/grants'))});});
   page.on('requestfailed',r=>{if(r.failure()?.errorText!=='net::ERR_ABORTED')requestFailures.push({url:r.url(),expected:r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/grants')});});
   await context.routeWebSocket('**/*',s=>{const u=new URL(s.url());if(u.pathname==='/_next/webpack-hmr')return s.connectToServer();if(u.pathname==='/socket.io/'){s.send('0'+JSON.stringify({sid:'synthetic',upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1000000}));s.onMessage(m=>{if(typeof m==='string'&&m.startsWith('40'))s.send('40'+JSON.stringify({sid:'synthetic'}));});return;}unexpected.push('websocket '+u.pathname);s.close();});
   await context.route('**/*',async route=>{
    const r=route.request(),u=new URL(r.url()),json=(v,status=200)=>route.fulfill({status,json:v});if(u.origin!==origin){unexpected.push('external '+u.hostname);return route.abort();}
    if(u.pathname==='/api/v1/auth/browser-session')return json({accessToken:'SYNTHETIC_BROWSER_SESSION_ONLY',user:{sub:id(1),username:'synthetic',fullName:'ADMIN SINTETICO',roles:['ADMIN'],permissions:['document.view','document.issue','sunat.configure','setup.manage','user.manage'],scope:{kind:'GLOBAL'},authVersion:1},serverNow:Date.now(),idleExpiresAt:Date.now()+1800000});
    if(u.pathname==='/api/v1/auth/browser-session/activity')return json({serverNow:Date.now(),idleExpiresAt:Date.now()+1800000});
    if(u.pathname==='/api/v1/documents/catalog/issuance')return json({companies:[{id:1,ruc:'20000000001',legalName:'SYNTHETIC ONLY',environment:'BETA',active:true}],branches:[{id:id(2),companyId:1,name:'SEDE SINTETICA',code:'S1',active:true,establishmentCode:'0001'}],emissionPoints:[{id:id(3),companyId:1,branchId:id(2),name:'PUNTO SINTETICO',code:'P1',active:true,series:[]}],products:[]});
    if(u.pathname==='/api/v1/users')return json([{id:id(1),fullName:'ADMIN SINTETICO',active:true}]);
    if(u.pathname==='/api/v1/setup/sunat/1/PRODUCTION/guides/administration')return json({version:'factuez.gre-administration-status.v1',companyId:1,issuerRuc:'20000000001',revision:0,draft:{version:'factuez.gre-administration.v1',vehicles:[],drivers:[],routes:[],goodsCodes:[],approvals:[]},catalogueRevision:0,hasCatalogue:false,goods:{available:true,items:[]},rules:{verified:true},publicationBlockers:[],history:[]});
    if(u.pathname.startsWith('/api/v1/production-guides')){
     let body=r.method()==='POST'?r.postDataJSON():undefined;
     if(r.method()==='POST'){posts.push({path:u.pathname,body});if(u.pathname.endsWith('/grants')){const fault=grantFault;grantFault=undefined;if(fault==='500')return json({statusCode:500,code:'INTERNAL_ERROR',message:'Fallo sintetico de respuesta'},500);if(fault==='lost')return route.abort('failed');unexpected.push('unrequested-grant-write');return route.abort();}if(injectInvalid){injectInvalid=false;body={...body,extra:true};}}
     if(failVerification&&u.pathname.endsWith('/capabilities')){failVerification=false;return json({message:'Lectura de verificacion rechazada sintetica',code:'INVALID_REQUEST'},400);}
     const reply=await request(u.pathname+u.search,r.method(),body),value=await reply.json();
     // Isolated presentation-only fixtures exercise shared grant/revoke UI paths.
     // No grant POST is ever forwarded; real fiscal settings and DB remain intact.
     if(grantFixture&&u.pathname.endsWith('/capabilities'))value.fiscal={...value.fiscal,ready:true,credentialRevision:1};
     if(grantFixture&&u.pathname.includes('/series/point/'))value.series=localSelectionMissing?[]:value.series.map(s=>({...s,grant:{version:1,enabled:true,expiresAt:'2027-12-31T00:00:00Z'}}));
     return json(value,reply.status);
    }
    if(!u.pathname.startsWith('/api/'))return route.continue();unexpected.push('unhandled '+r.method()+' '+u.pathname);return route.abort();
   });
   const check=(v,label)=>{assert.ok(v,label);checks.push(label);};
   const shot=async label=>{check(await page.evaluate(()=>Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)<=innerWidth),'no-overflow-'+label);await page.screenshot({path:path.join(ui,name+'-'+label+'.png'),fullPage:true});};
   const create=async value=>{await page.locator('#gre-new-series').fill(value);await page.getByRole('button',{name:'Crear serie',exact:true}).click();await pw.expect(page.getByRole('dialog')).toBeVisible();};
   // Accessible names use Unicode escapes so this remains portable in Windows tooling.
   const submit=()=>page.getByRole('button',{name:'Confirmar acci\u00f3n',exact:true}).click();
   const selectContext=async()=>{await page.getByRole('combobox',{name:'Emisor RUC activo'}).click();await page.getByRole('option',{name:/20000000001/}).click();await page.getByRole('combobox',{name:'Sede activa',exact:true}).click();await page.getByRole('option',{name:/SEDE SINTETICA/}).click();};
   try{
    await page.goto(origin+'/guide-settings/series');await selectContext();
    await pw.expect(page.locator('#gre-admin-point')).toHaveValue(id(3));
    await create('T099');check(posts.length===0,'confirmation-does-not-submit');await page.getByRole('button',{name:'Confirmar acci\u00f3n',exact:true}).evaluate(button=>{button.click();button.click();});
    await pw.expect(page.getByRole('dialog')).toHaveCount(0);await pw.expect(page.getByText(/La serie ya existe para esta empresa/)).toBeVisible();await pw.expect(page.locator('#gre-new-series')).toHaveValue('T099');await pw.expect(page.getByRole('button',{name:'Crear serie',exact:true})).toBeEnabled();check(posts.length===1,'duplicate-no-auto-repost');await shot('duplicate-conflict');
    injectInvalid=true;await create(index?'T105':'T104');await submit();await pw.expect(page.getByRole('dialog')).toHaveCount(0);await pw.expect(page.getByText(/contiene campos faltantes/)).toBeVisible();await pw.expect(page.getByRole('button',{name:'Crear serie',exact:true})).toBeEnabled();check(posts.length===2,'invalid-payload-400-recoverable-no-auto-repost');
    await create(index?'T105':'T104');await submit();await pw.expect(page.getByRole('dialog')).toHaveCount(0);await pw.expect(page.getByText(/Configuracion GRE guardada|Configuraci\u00f3n GRE guardada/)).toBeVisible();await pw.expect(page.getByText((index?'T105':'T104')+' - GRE 09 - Sin concesi\u00f3n activa',{exact:true})).toBeVisible();await pw.expect(page.getByRole('button',{name:'Autorizar perfil y actor'})).toBeDisabled();check(posts.length===3,'explicit-correction-created-after-conflict-visible-list-and-disabled-grant');await shot('created-no-grant');
    await create(index?'T107':'T106');failVerification=true;await submit();await pw.expect(page.getByRole('dialog')).toHaveCount(0);await pw.expect(page.getByRole('button',{name:'Consultar series y autorizaciones'})).toBeVisible();await pw.expect(page.getByRole('button',{name:'Crear serie',exact:true})).toBeDisabled();await pw.expect(page.getByText(/Configuraci\u00f3n GRE guardada/)).toHaveCount(0);check(posts.length===4,'successful-write-failed-read-remains-uncertain-without-stale-success');await shot('uncertain-accessible');
    await page.getByRole('button',{name:'Consultar series y autorizaciones'}).click();await pw.expect(page.getByRole('button',{name:'Crear serie',exact:true})).toBeEnabled();check(posts.length===4,'reconciliation-only-reads-never-reposts');
    check(posts.every(p=>p.path==='/api/v1/production-guides/series'&&p.body.pointId===id(3)&&p.body.expectedPointRevision===1&&Object.keys(p.body).sort().join(',')==='expectedPointRevision,pointId,series'),'exact-form-payload-no-grant-or-counter-fields');
    await pw.expect(page.getByRole('button',{name:'Autorizar perfil y actor'})).toBeDisabled();check(true,'fiscal-incomplete-grant-remains-disabled');
    const seriesPostCount=posts.length;grantFixture=true;await page.reload();await selectContext();const t099=await page.locator('#gre-grant-series option').filter({hasText:'T099'}).getAttribute('value');await page.locator('#gre-grant-series').selectOption(t099);await page.locator('#gre-grant-expiry').fill('2027-12-31T12:00');
    grantFault='500';await page.getByRole('button',{name:'Autorizar perfil y actor'}).click();await submit();await pw.expect(page.getByRole('dialog')).toHaveCount(0);await pw.expect(page.getByRole('button',{name:'Consultar series y autorizaciones'})).toBeVisible();await pw.expect(page.getByRole('button',{name:'Autorizar perfil y actor'})).toBeDisabled();check(posts.length===seriesPostCount+1,'grant-500-blocks-no-auto-repost-UI-fixture-only');await page.getByRole('button',{name:'Consultar series y autorizaciones'}).click();await pw.expect(page.getByRole('button',{name:'Autorizar perfil y actor'})).toBeEnabled();
    grantFault='lost';await page.getByRole('button',{name:'Suspender concesi\u00f3n'}).click();await submit();await pw.expect(page.getByRole('dialog')).toHaveCount(0);await pw.expect(page.getByRole('button',{name:'Consultar series y autorizaciones'})).toBeVisible();await pw.expect(page.getByRole('button',{name:'Suspender concesi\u00f3n'})).toBeDisabled();check(posts.length===seriesPostCount+2,'revoke-lost-response-blocks-no-auto-repost-UI-fixture-only');await page.getByRole('button',{name:'Consultar series y autorizaciones'}).click();await pw.expect(page.getByRole('button',{name:'Suspender concesi\u00f3n'})).toBeEnabled();check(posts.length===seriesPostCount+2,'grant-revoke-reconciliation-only-reads');
    localSelectionMissing=true;await page.reload();await selectContext();await page.locator('#gre-grant-series').selectOption(t099);await page.locator('#gre-grant-expiry').fill('2027-12-31T12:00');await page.getByRole('button',{name:'Autorizar perfil y actor'}).click();await submit();await pw.expect(page.getByRole('dialog')).toHaveCount(0);await pw.expect(page.getByText('Seleccione una serie',{exact:true})).toBeVisible();await pw.expect(page.getByRole('button',{name:'Consultar series y autorizaciones'})).toHaveCount(0);check(posts.length===seriesPostCount+2,'local-validation-before-send-never-uncertain-or-posted');
    assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(requestFailures.filter(e=>!e.expected),[]);assert.deepEqual(network.filter(e=>!e.expected),[]);assert.deepEqual(consoleErrors.filter(e=>!network.some(n=>n.expected&&n.url===e.url&&e.text.includes(String(n.status)))&&!requestFailures.some(n=>n.expected&&n.url===e.url&&e.text.includes('ERR_FAILED'))),[]);
    results.push({name,viewport,status:'passed',checks,posts,network,requestFailures,consoleErrors,pageErrors,unexpected});
   }catch(e){await page.screenshot({path:path.join(ui,name+'-failure.png'),fullPage:true});results.push({name,viewport,status:'failed',error:e.message,checks,posts,network,requestFailures,consoleErrors,pageErrors,unexpected});throw e;}finally{await context.close();}
  }
 }finally{
  fs.writeFileSync(path.join(ui,'results.json'),JSON.stringify(results,null,2)+'\n');await browser?.close();if(process.platform==='win32')spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill();fs.closeSync(log);
 }
}
module.exports={seriesUi};
