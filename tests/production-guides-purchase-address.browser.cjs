'use strict';
// Real Next/Chrome, shipping Kong -> actual Billing/Identity/PG for capabilities.
// The three fiscal states are explicit presentation fixtures; no grant is submitted.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process'),{createRequire}=require('node:module');
const {main}=require('./native-gre-bootstrap.e2e.cjs'),{withSeriesKong}=require('./helpers/gre-series-kong.cjs');
assert.deepEqual(process.argv.slice(2),['--isolated-synthetic-only']);
const root=path.resolve(__dirname,'..'),output=path.join(root,'output/gre-series-administration-lifecycle-20261127/t099/browser');
async function run(){await main({enabled:true,output,work:async({http,billingDb,publicPorts,token,id,ruc,result})=>{
 const ui=path.join(output,'ui');fs.mkdirSync(ui,{recursive:true});
 await billingDb.query(`INSERT INTO "SeriesCounter" (id,"companyId","emissionPointId","documentType",series,environment,"updatedAt") VALUES ($1,1,$2,'DESPATCH_ADVICE','T991','PRODUCTION',now())`,[id(991),id(3)]);
 const app=path.join(root,'apps/web-pwa'),local=createRequire(path.join(app,'package.json'));
 const pw=createRequire(process.env.FACTUEZ_PLAYWRIGHT_PACKAGE_JSON||'C:/Users/maxmo/orca/workspaces/FactuEz/codex-programador-preflight-20261102/package.json')('@playwright/test');
 for(const dir of [root,app])for(const file of ['.env','.env.local','.env.development','.env.development.local'])assert(!fs.existsSync(path.join(dir,file)),'REFUSED_ENV_FILE');
 const probe=require('node:net').createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
 const env={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];Object.assign(env,{NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_API_BASE_URL:origin});
 const log=fs.openSync(path.join(ui,'server.log'),'w'),server=spawn(process.execPath,[local.resolve('next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',String(port)],{cwd:app,env,windowsHide:true,stdio:['ignore',log,log]});const results=[];let browser;
 try{
  let healthy=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/login')).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert(healthy,'PWA_START');
  browser=await pw.chromium.launch({channel:'chrome',headless:true});
  await withSeriesKong({root,output,port:publicPorts.billing,token},async request=>{
   for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const name=viewport.width===390?'mobile':'desktop',context=await browser.newContext({viewport,serviceWorkers:'block'}),page=await context.newPage(),errors=[],unexpected=[],checks=[],posts=[],capabilities=[],canceledReads=[];let state='catalogue';
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await context.routeWebSocket('**/*',socket=>{const u=new URL(socket.url());if(u.origin!==origin.replace('http:','ws:')){unexpected.push('external socket');return socket.close();}if(u.pathname==='/_next/webpack-hmr')return socket.connectToServer();if(u.pathname==='/socket.io/'){socket.send('0'+JSON.stringify({sid:'synthetic',upgrades:[],pingInterval:25000,pingTimeout:20000,maxPayload:1000000}));socket.onMessage(m=>{if(typeof m==='string'&&m.startsWith('40'))socket.send('40'+JSON.stringify({sid:'synthetic'}));});return;}unexpected.push('socket '+u.pathname);socket.close();});
    await context.route('**/*',async route=>{try{
     const req=route.request(),u=new URL(req.url()),json=async(v,status=200)=>{try{return await route.fulfill({status,json:v});}catch(e){if(req.method()==='GET'&&/Route is already handled|Target.*closed/i.test(e.message)){canceledReads.push({path:u.pathname,reason:'canceled browser read'});return;}throw e;}};
     if(u.origin!==origin){unexpected.push('external '+u.hostname);return route.abort();}
     if(u.pathname==='/api/v1/auth/browser-session')return json({accessToken:'SYNTHETIC_PRESENTATION_ONLY',user:{sub:id(1),username:'synthetic',fullName:'ADMIN SINTETICO',roles:['ADMIN'],permissions:['document.view','document.issue','sunat.configure','setup.manage','user.manage'],scope:{kind:'GLOBAL'},authVersion:1},serverNow:Date.now(),idleExpiresAt:Date.now()+1800000});
     if(u.pathname==='/api/v1/auth/browser-session/activity')return json({serverNow:Date.now(),idleExpiresAt:Date.now()+1800000});
     if(u.pathname==='/api/v1/documents/catalog/issuance')return json({companies:[{id:1,ruc,legalName:'SYNTHETIC ONLY',environment:'BETA',active:true}],branches:[{id:id(2),companyId:1,name:'SEDE SINTETICA',code:'S1',active:true,establishmentCode:'0001'}],emissionPoints:[{id:id(3),companyId:1,branchId:id(2),name:'PUNTO SINTETICO',code:'P1',active:true,series:[]}],products:[]});
     if(u.pathname==='/api/v1/users')return json([{id:id(1),fullName:'ADMIN SINTETICO',active:true}]);
     // This task preserves the separate unfinished CRUD. Its panel is excluded.
     if(u.pathname==='/api/v1/production-guides/series/administration')return json({version:'factuez.gre-series-administration.v1',companyId:1,issuerRuc:ruc,items:[],nextCursor:null});
     if(u.pathname.startsWith('/api/v1/setup/sunat/')){const body=req.method()==='GET'?undefined:req.postDataJSON();if(body)posts.push({path:u.pathname,body});const reply=await http('sunat',u.pathname+u.search,req.method(),body);return json(await reply.json(),reply.status);}
     if(u.pathname.startsWith('/api/v1/production-guides')){
      if(req.method()!=='GET'){unexpected.push('forbidden fiscal write '+u.pathname);return route.abort();}
      const reply=await request(u.pathname+u.search),value=await reply.json();
      if(u.pathname.endsWith('/capabilities')){
       assert.equal(reply.status,200);assert.equal(value.companyId,1);assert(value.series.some(s=>s.series==='T991'));capabilities.push({state,status:reply.status,realFiscalBlockers:value.fiscal?.blockers});
       const catalogue=state==='catalogue'?null:{goods:[],routes:[],vehicles:[],drivers:[]};
       value.fiscal={ready:state==='ready',credentialRevision:1,catalogue,blockers:state==='catalogue'?['Catálogo de bienes, rutas y transportes revisado pendiente']:state==='pki'?['Credenciales, certificado, confianza PKI/CRL o XSD no válidos']:[]};
      }
      return json(value,reply.status);
     }
     if(!u.pathname.startsWith('/api/'))return route.continue();unexpected.push('unhandled '+req.method()+' '+u.pathname);return route.abort();
    }catch(e){unexpected.push('handler '+e.message);await route.abort().catch(()=>{});}});
    const shot=async label=>{await pw.expect(page.locator('body')).toHaveCSS('margin','0px');assert(await page.evaluate(()=>Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)<=innerWidth),'OVERFLOW_'+label);await page.screenshot({path:path.join(ui,name+'-'+label+'.png'),fullPage:true});};
    try{
     await page.goto(origin+'/guide-settings/series');await page.getByRole('combobox',{name:'Emisor RUC activo'}).click();await page.getByRole('option',{name:new RegExp(ruc)}).click();await page.getByRole('combobox',{name:'Sede activa',exact:true}).click();await page.getByRole('option',{name:/SEDE SINTETICA/}).click();
     const authorize=()=>page.getByRole('button',{name:'Autorizar perfil y actor',exact:true});
     await pw.expect(page.locator('#gre-admin-point')).toHaveValue(id(3));await pw.expect(authorize()).toBeDisabled();const blockers=page.getByRole('region',{name:'Requisitos para autorizar'});
     await pw.expect(blockers).toContainText('Catálogo de bienes, rutas y transportes revisado pendiente');await pw.expect(blockers.getByRole('link',{name:'Revisar credenciales y certificado SUNAT'})).toHaveCount(0);await shot('catalogue-pending');checks.push('catalogue-only-blocker-has-correct-next-step');
     await blockers.getByRole('link',{name:'Revisar habilitaciones y publicar catálogo'}).click();await pw.expect(page).toHaveURL(origin+'/guide-settings/review');await pw.expect(page.getByText('Habilitaciones por sede y familia',{exact:true})).toBeVisible();checks.push('catalogue-link-navigates-to-real-review-route');
     await page.getByRole('navigation',{name:'Administración GRE'}).getByRole('link',{name:'Rutas',exact:true}).click();await page.getByRole('button',{name:'Nueva ruta',exact:true}).click();await page.locator('#gre-admin-name').fill('SYNTHETIC '+name);await page.locator('#gre-admin-purchase').selectOption('yes');await page.locator('#gre-admin-originUbigeo').fill('070106');await page.locator('#gre-admin-destinationUbigeo').fill('150502');await page.locator('#gre-admin-originAddress').fill('SYNTHETIC PROVIDER '+name);await page.locator('#gre-admin-destinationAddress').fill('SYNTHETIC ACTUAL ARRIVAL '+name);await page.locator('#gre-admin-supplierRuc').fill('20000000028');await page.locator('#gre-admin-supplierName').fill('PROVEEDOR SINTETICO');await shot('purchase-route-no-codes');await page.getByRole('button',{name:'Guardar ruta',exact:true}).click();await pw.expect(page.getByRole('dialog')).toHaveCount(0);
     const saved=posts.findLast(p=>p.path.endsWith('/guides/administration'));assert(saved);const place=saved.body.draft.routes.find(r=>r.name==='SYNTHETIC '+name);assert(!Object.hasOwn(place.origin,'establishmentCode'));assert(!Object.hasOwn(place.destination,'establishmentCode'));checks.push('real-administration-PUT-saves-omitted-codes-and-different-arrival');
     await page.getByRole('navigation',{name:'Administración GRE'}).getByRole('link',{name:'Series y permisos',exact:true}).click();await page.locator('#gre-grant-series').selectOption(id(991));await page.locator('#gre-grant-expiry').fill('2026-12-31T12:00');await pw.expect(authorize()).toBeDisabled();
     state='ready';await page.getByRole('button',{name:'Actualizar requisitos para autorizar'}).click();await pw.expect(authorize()).toBeEnabled();await pw.expect(page.getByRole('region',{name:'Requisitos para autorizar'})).toHaveCount(0);await shot('catalogue-present');checks.push('complete-readiness-enables-explicit-review-without-sending-grant');
     state='pki';await page.getByRole('button',{name:'Actualizar requisitos para autorizar'}).click();await page.locator('#gre-grant-series').selectOption(id(991));await page.locator('#gre-grant-expiry').fill('2026-12-31T12:00');await pw.expect(authorize()).toBeDisabled();const pki=page.getByRole('region',{name:'Requisitos para autorizar'});await pw.expect(pki).toContainText('PKI/CRL');await pw.expect(pki.getByRole('link',{name:'Revisar habilitaciones y publicar catálogo'})).toHaveCount(0);await shot('pki-error');await pki.getByRole('link',{name:'Revisar credenciales y certificado SUNAT'}).click();await pw.expect(page).toHaveURL(origin+'/sunat-settings');await pw.expect(page.getByRole('heading',{name:'Configuración SUNAT',exact:true})).toBeVisible();await shot('sunat-link');checks.push('pki-blocker-stays-closed-and-link-navigates-to-real-sunat-settings');
     assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);results.push({name,viewport,status:'passed',checks,capabilities,adminPosts:posts.length,canceledReads,errors,unexpected});
    }catch(e){await page.screenshot({path:path.join(ui,name+'-failure.png'),fullPage:true});results.push({name,viewport,status:'failed',error:e.stack,checks,errors,unexpected,body:await page.locator('body').innerText()});throw e;}finally{await page.close();await context.unrouteAll({behavior:'ignoreErrors'});await context.close();}
   }
  });result.checks.push('actual-PWA-Chrome-Kong-desktop-mobile-addresses-and-fiscal-blocker-navigation');
 }finally{fs.writeFileSync(path.join(ui,'results.json'),JSON.stringify({synthetic:true,limits:['Fiscal states overlaid for presentation; actual grant evidence tested separately','Separate unfinished CRUD panel excluded','No browser grant POST or fiscal submission permitted'],results},null,2));await browser?.close();if(process.platform==='win32')spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill();fs.closeSync(log);}
 }});}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
