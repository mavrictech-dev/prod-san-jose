// Real PWA, mocked API; backend/PostgreSQL coverage is in the separate DB/HTTP runner.
// Reuses the explicitly supplied preflight Playwright installation without changing dependencies.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = process.argv[2];
if (!packagePath || !/package\.json$/.test(packagePath)) throw Error('Pass the absolute preflight package.json path containing Playwright 1.64.1');
const require = createRequire(resolve(packagePath));
const { chromium, expect } = require('@playwright/test');
assert.equal(require('@playwright/test/package.json').version, '1.64.1');
const ORIGIN = 'http://127.0.0.1:3117', output = join(root, process.argv[3] === '--fuel-profile' ? 'output/fuel-profile/ui' : process.argv[3] === '--review-followup' ? 'output/guide-settings/ui-review' : 'output/guide-settings/ui'); mkdirSync(output, { recursive: true });
const companies = [1,2].map(id => ({ id, legalName: `EMISOR FICTICIO ${id === 1 ? 'ALFA' : 'BETA'} - Operaciones sintéticas de traslado y abastecimiento`, ruc: `0000000000${id}`, environment: 'PRODUCTION' }));
const user = { sub: '00000000-0000-4000-8000-000000003117', username: 'synthetic-only', roles: ['ADMIN'], permissions: ['setup.manage','document.view','sunat.configure'], scope: { kind: 'GLOBAL' }, exp: Math.floor(Date.now()/1000)+3600 };
const catalog = { companies, branches: [], emissionPoints: [], products: [], capabilities: { demoData: false, fiscalTransmission: false } };
const doc = (id, settings = null, revision = 0) => ({ version: 'factuez.guide-operational-settings.v1', companyId: id, ruc: companies[id-1].ruc, settings, revision, updatedAt: settings ? '2026-11-25T12:00:00.000Z' : null, updatedBy: settings ? user.sub : null, configured: !!settings, status: settings ? 'PROFILE_REVIEW_PENDING' : 'NOT_CONFIGURED', fiscalTransmission: false });
const longProduct = 'Diésel B5 S-50 sintético para abastecimiento de maquinaria y operaciones de transporte - presentación comercial declarada por la empresa';
const longAddress = 'Avenida Ficticia de los Ensayos 123, lote 45, almacén de pruebas y patio de distribución de combustible sintético, referencia: frente al parque industrial de demostración sin datos reales';
const results = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking','--disable-component-update','--disable-sync','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
for (const [name, viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]) {
  const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile', serviceWorkers: 'block' });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage(); const log = { console: [], network: [], pageErrors: [], violations: [] }, checks = [];
  const state = { documents: new Map([[1,doc(1)],[2,doc(2)]]), mode: 'normal', putCount: 0, hold: null, getHold: null };
  page.on('console', m => log.console.push({type:m.type(),text:m.text()})); page.on('pageerror', e => log.pageErrors.push(e.message));
  page.on('response', r => log.network.push({method:r.request().method(),url:r.url(),status:r.status()}));
  page.on('requestfailed', r => log.network.push({method:r.method(),url:r.url(),failure:r.failure()?.errorText}));
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.origin === 'ws://127.0.0.1:3117' && url.pathname === '/_next/webpack-hmr') socket.connectToServer();
    else if (url.origin === 'ws://127.0.0.1:3117' && url.pathname === '/socket.io/') {
      socket.send('0'+JSON.stringify({sid:'synthetic',upgrades:[],pingInterval:25000,pingTimeout:20000}));
      socket.onMessage(message => { if (typeof message === 'string' && message.startsWith('40')) socket.send('40'+JSON.stringify({sid:'synthetic-namespace'})); });
    } else { log.violations.push(`WS ${socket.url()}`); socket.close(); }
  });
  await context.route('**/*', async route => {
    const request=route.request(), url=new URL(request.url()), method=request.method();
    if (url.origin !== ORIGIN) { log.violations.push(url.href); await route.abort(); return; }
    if (url.pathname === '/api/v1/auth/browser-session') { await route.fulfill({json:{accessToken:'fictional-guide-ui-token',user,expiresIn:3600,serverNow:Date.now(),idleExpiresAt:Date.now()+1800000,idleTimeoutSeconds:1800}}); return; }
    if (url.pathname === '/api/v1/auth/browser-session/activity') { await route.fulfill({json:{serverNow:Date.now(),idleExpiresAt:Date.now()+1800000,idleTimeoutSeconds:1800}}); return; }
    if (url.pathname === '/api/v1/documents/catalog/issuance') { await route.fulfill({json:catalog}); return; }
    const match=url.pathname.match(/^\/api\/v1\/stations\/issuers\/(\d+)\/guide-settings$/);
    if (match) {
      const id=Number(match[1]);
      if (method === 'GET') {
        if (state.getHold) { const hold=state.getHold; await hold.pending; }
        if (state.mode==='403' || state.mode==='503') await route.fulfill({status:Number(state.mode),json:{message:state.mode==='403'?'Acceso denegado sintético':'Almacenamiento pendiente sintético'}});
        else await route.fulfill({json:state.documents.get(id)});
      } else if (method === 'PUT') {
        state.putCount++; const body=request.postDataJSON();
        if (state.hold) await state.hold.pending;
        if (state.mode==='conflict' || body.expectedRevision !== state.documents.get(id).revision) await route.fulfill({status:409,json:{message:'Conflicto sintético'}});
        else if (state.mode==='lost') { state.documents.set(id,doc(id,body.settings,body.expectedRevision+1)); await route.abort('failed'); }
        else { const value=doc(id,body.settings,body.expectedRevision+1); state.documents.set(id,value); await route.fulfill({json:value}); }
      } else throw Error(`Unexpected method ${method}`);
      return;
    }
    if (url.pathname === '/api/v1/gre-qa/capabilities') { await route.fulfill({json:{enabled:false,fiscalTransmission:false}}); return; }
    if (url.pathname.startsWith('/api/')) { log.violations.push(`${method} ${url.pathname}`); await route.fulfill({status:404,json:{message:'Unexpected synthetic API'}}); return; }
    await route.continue();
  });
  const gate = () => { let release; const pending=new Promise(r=>{release=r;}); return {pending,release}; };
  async function choose(label, option) { await page.getByRole('combobox',{name:label,exact:true}).click(); await page.getByRole('option',{name:option,exact:true}).click(); }
  async function tab(value) { await page.getByRole('tab',{name:value,exact:true}).click(); }
  async function selectCompany(id) { await page.getByRole('combobox',{name:'Emisor RUC activo',exact:true}).click(); await page.getByRole('option').filter({hasText:companies[id-1].ruc}).click(); }
  async function reloadSelected(id=1) { await page.reload(); await expect(page.getByRole('heading',{name:'Configuración de guías',exact:true})).toBeVisible(); await choose('Fuente del catálogo','Laboratorios QA'); await selectCompany(id); }
  async function screenshot(suffix, fullPage=true) { await page.screenshot({path:join(output,`${name}-${suffix}.png`),fullPage}); }
  async function noOverflow() { assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), `${name}: horizontal page overflow`); }
  try {
    await page.goto(`${ORIGIN}/guide-settings`);
    await expect(page.getByRole('heading',{name:'Configuración de guías',exact:true})).toBeVisible();
    await expect(page.getByText('Seleccione un emisor en la cabecera para configurar sus guías.',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Guardar configuración',exact:true})).toBeDisabled(); checks.push('NO_COMPANY_NO_EDIT');
    await screenshot('no-company');
    await choose('Fuente del catálogo','Laboratorios QA'); await selectCompany(1);
    await expect(page.getByText('Sin configurar',{exact:true})).toBeVisible(); await screenshot('empty'); checks.push('EMPTY_NO_INVENTED_DATA');
    await tab('Emisor'); await choose('Emite como','Remitente y transportista');
    await page.getByRole('button',{name:'Guardar configuración',exact:true}).click(); await expect(page.getByRole('alert').filter({hasText:'Revise los campos indicados'})).toBeVisible(); assert.equal(state.putCount,0); checks.push('CLIENT_VALIDATION_NO_PUT');
    await tab('Productos'); await page.getByRole('button',{name:'Agregar producto',exact:true}).click();
    await page.getByLabel('Nombre comercial / producto exacto',{exact:true}).fill(longProduct); await choose('Tipo de producto','Combustible'); await choose('Unidad de medida','Galones (GLL)'); await page.getByLabel('Código comercial (opcional)',{exact:true}).fill('SYNTHETIC-DB5');
    await page.getByRole('button',{name:'Agregar producto',exact:true}).click(); await page.getByRole('button',{name:'Quitar producto 2',exact:true}).click(); await expect(page.getByLabel('Nombre comercial / producto exacto',{exact:true})).toHaveCount(1); checks.push('ADD_REMOVE_PRODUCT_DRAFT');
    await noOverflow(); await screenshot('fuel-product');
    await tab('Rutas');
    await expect(page.getByText('Direcciones y UBIGEO declarados por su empresa, pendientes de revisión. El SCOP, cuando corresponda, es un dato de cada operación y no se guarda como valor fijo en esta configuración.',{exact:true})).toBeVisible();
    await expect(page.getByText('El SCOP de cada operación se registra por separado al preparar el traslado.',{exact:false})).toHaveCount(0); checks.push('SCOP_NOTICE_NO_UNIMPLEMENTED_WORKFLOW_PROMISE');
    await page.getByRole('button',{name:'Agregar ruta',exact:true}).click(); await page.getByLabel('Nombre de la ruta',{exact:true}).fill('Abastecimiento sintético de planta a estación - ruta declarada por la empresa');
    for (const [index,legend] of ['Punto de partida','Punto de llegada'].entries()) {
      const fieldset=page.getByRole('group',{name:legend,exact:true});
      await fieldset.getByLabel('Dirección',{exact:true}).fill(longAddress+` - ${index===0?'origen':'destino'}`);
      await fieldset.getByLabel('UBIGEO (6 dígitos)',{exact:true}).fill(index===0?'150101':'200101');
      await fieldset.getByLabel('Departamento',{exact:true}).fill(index===0?'Lima':'Piura'); await fieldset.getByLabel('Provincia',{exact:true}).fill(index===0?'Lima':'Piura'); await fieldset.getByLabel('Distrito',{exact:true}).fill(index===0?'Lima':'Piura'); await fieldset.getByLabel('Establecimiento SUNAT (opcional, 4 dígitos)',{exact:true}).fill('0001');
    }
    await page.getByRole('button',{name:'Agregar ruta',exact:true}).click(); await page.getByRole('button',{name:'Quitar ruta 2',exact:true}).click(); await expect(page.getByLabel('Nombre de la ruta',{exact:true})).toHaveCount(1); checks.push('ADD_REMOVE_ROUTE_DRAFT');
    await noOverflow(); await screenshot('route'); checks.push('FUEL_AND_COMPLETE_ROUTE_LONG_TEXT_NO_OVERFLOW');
    await tab('Combustibles');
    await page.getByRole('button',{name:'Preparar perfil de combustibles',exact:true}).click();
    await expect(page.getByText('Perfil pendiente de completar',{exact:true})).toBeVisible();checks.push('FUEL_REVIEW_NOT_AUTOMATIC');
    await page.getByLabel('Registro de hidrocarburos del emisor',{exact:true}).fill('REGISTRO-SINTETICO');
    await choose(`Familia: ${longProduct}`,'Diésel');
    await choose('Régimen del traslado','GRE de bienes fiscalizados');
    await expect(page.getByText(/requiere el sistema GRE de bienes fiscalizados de SUNAT/)).toBeVisible();
    await noOverflow();await screenshot('fuel-bf-outside-ordinary-profile');checks.push('FUEL_BF_NEVER_SHOWN_AS_ORDINARY_READY');
    await choose('Régimen del traslado','GRE ordinaria');await choose('SCOP por operación','Requerido en cada traslado');
    await choose('Modalidad de transporte','Público (transportista contratado)');await choose('Motivo del traslado','Venta');
    await expect(page.getByText('Datos completos para revisión técnica',{exact:true})).toBeVisible();
    await expect(page.getByText('Remitente: 09 pública, requiere habilitación por sede, combustible, ruta y transportista',{exact:true})).toBeVisible();
    await expect(page.getByText('Transportista: vinculado a una guía remitente aceptada',{exact:true})).toHaveCount(0);
    await noOverflow();await screenshot('fuel-profile-complete');checks.push('FUEL_COMPLETE_DECLARATIONS_NO_FISCAL_ACTIVATION');
    state.hold=gate(); const button=page.getByRole('button',{name:'Guardar configuración',exact:true}); await button.click();
    await expect(page.getByRole('button',{name:'Guardando…',exact:true})).toBeDisabled(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    assert.equal(state.putCount,1); await screenshot('saving'); state.hold.release(); state.hold=null;
    await expect(page.getByText('Datos guardados. Revisión del perfil pendiente.',{exact:true})).toBeVisible(); assert.equal(state.putCount,1); assert.equal(state.documents.get(1).settings.products[0].type,'FUEL'); checks.push('DOUBLE_SUBMIT_BLOCKED_SAVE_PRESERVES_FUEL');
    await reloadSelected(); await expect(page.getByText('Datos guardados',{exact:true})).toBeVisible(); await tab('Productos'); await expect(page.getByLabel('Nombre comercial / producto exacto',{exact:true})).toHaveValue(longProduct); checks.push('SAVE_RELOAD_MOCK_PERSISTENCE'); await screenshot('reloaded');
    await tab('Combustibles');await expect(page.getByLabel('Registro de hidrocarburos del emisor',{exact:true})).toHaveValue('REGISTRO-SINTETICO');
    await expect(page.getByText('Datos completos para revisión técnica',{exact:true})).toBeVisible();
    assert.equal(state.documents.get(1).settings.fuelProfile.routes[0].scop,'REQUIRED');
    assert.ok(!Object.hasOwn(state.documents.get(1).settings.fuelProfile,'scopCode'));checks.push('FUEL_PROFILE_SAVE_RELOAD_NO_STATIC_SCOP');await tab('Productos');
    await page.getByLabel('Nombre comercial / producto exacto',{exact:true}).fill('Diésel B5 - borrador conservado'); state.mode='conflict';
    await page.getByRole('button',{name:'Guardar configuración',exact:true}).click(); await expect(page.getByRole('alert').filter({hasText:'Otra persona guardó cambios'})).toBeVisible(); await expect(page.getByLabel('Nombre comercial / producto exacto',{exact:true})).toHaveValue('Diésel B5 - borrador conservado'); await expect(page.getByRole('button',{name:'Guardar configuración',exact:true})).toBeDisabled(); await screenshot('conflict');
    state.documents.set(1,{...state.documents.get(1),revision:2}); state.mode='normal'; await page.getByRole('button',{name:'Revisar datos guardados',exact:true}).click(); await expect(page.getByText('Datos actuales del servidor',{exact:true})).toBeVisible(); await screenshot('conflict-review'); await page.getByRole('button',{name:'Conservar mi borrador',exact:true}).click(); await page.getByRole('button',{name:'Guardar configuración',exact:true}).click(); await expect(page.getByText('Datos guardados. Revisión del perfil pendiente.',{exact:true})).toBeVisible(); assert.equal(state.documents.get(1).revision,3); checks.push('409_PRESERVES_DRAFT_EXPLICIT_REVIEW_CAS');
    // Uncertain PUT commits in the mocked server but loses its response. Never auto retry.
    await page.getByLabel('Nombre comercial / producto exacto',{exact:true}).fill('Diésel B5 - respuesta perdida'); state.mode='lost'; const count=state.putCount;
    await page.getByRole('button',{name:'Guardar configuración',exact:true}).click(); await expect(page.getByRole('button',{name:'Revisar datos guardados',exact:true})).toBeVisible(); assert.equal(state.putCount,count+1); await expect(page.getByRole('button',{name:'Guardar configuración',exact:true})).toBeDisabled(); state.mode='normal'; await page.getByRole('button',{name:'Revisar datos guardados',exact:true}).click(); await page.getByRole('button',{name:'Usar datos guardados',exact:true}).click(); assert.equal(state.putCount,count+1); checks.push('UNCERTAIN_PUT_NO_AUTO_RETRY');
    await page.getByLabel('Nombre comercial / producto exacto',{exact:true}).fill('Cambios que no deben viajar al otro emisor'); await selectCompany(2); await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button',{name:'Seguir editando',exact:true}).click(); await expect(page.getByLabel('Nombre comercial / producto exacto',{exact:true})).toHaveValue('Cambios que no deben viajar al otro emisor');
    state.getHold=gate(); await selectCompany(2); await page.getByRole('button',{name:'Continuar',exact:true}).click(); await expect(page.getByLabel('Nombre comercial / producto exacto',{exact:true})).toHaveCount(0); await screenshot('company-loading'); state.getHold.release(); state.getHold=null; await expect(page.getByText('Sin configurar',{exact:true})).toBeVisible(); checks.push('DIRTY_CONTEXT_CONFIRM_AND_NO_PREVIOUS_COMPANY_FORM');
    // Late GET from A is ignored when B becomes active.
    state.getHold=gate(); const hold=state.getHold; await selectCompany(1); await selectCompany(2); hold.release(); state.getHold=null; await expect(page.getByText('Sin configurar',{exact:true})).toBeVisible(); await expect(page.getByText('Datos guardados',{exact:true})).toHaveCount(0); checks.push('STALE_GET_AFTER_CONTEXT_CHANGE_IGNORED');
    for (const status of ['403','503']) { state.mode=status; await reloadSelected(); await expect(page.getByText(status==='403'?'Acceso denegado. Se requiere un administrador general activo y un emisor activo.':'La configuración de guías no está disponible. El administrador debe preparar el almacenamiento en el servidor.',{exact:true})).toBeVisible(); await expect(page.getByRole('button',{name:'Guardar configuración',exact:true})).toHaveCount(0); await screenshot(status); checks.push(`${status}_SAFE_DISABLED_STATE`); }
    state.mode='normal'; await reloadSelected(); await tab('Emisor'); await page.getByRole('tab',{name:'Emisor',exact:true}).focus(); await page.keyboard.press('ArrowRight'); await expect(page.getByRole('tab',{name:'Productos',exact:true})).toHaveAttribute('aria-selected','true'); checks.push('KEYBOARD_TABS');
    // A pending save may finish for A after switching to B; its response must never populate B.
    await page.getByLabel('Nombre comercial / producto exacto',{exact:true}).fill('Diésel B5 - guardado previo al cambio de emisor');
    state.hold=gate(); const putHold=state.hold; await page.getByRole('button',{name:'Guardar configuración',exact:true}).click();
    await expect(page.getByRole('button',{name:'Guardando…',exact:true})).toBeDisabled(); await selectCompany(2); await page.getByRole('button',{name:'Continuar',exact:true}).click(); await expect(page.getByText('Sin configurar',{exact:true})).toBeVisible();
    putHold.release(); state.hold=null; await expect(page.getByText('Datos guardados. Revisión del perfil pendiente.',{exact:true})).toHaveCount(0); await expect(page.getByText('Sin configurar',{exact:true})).toBeVisible(); checks.push('STALE_PUT_RESPONSE_AFTER_CONTEXT_CHANGE_IGNORED');
    await screenshot('final-viewport',false);
    await noOverflow(); assert.deepEqual(log.pageErrors,[]); assert.deepEqual(log.violations,[]); checks.push('NO_PAGE_ERRORS_NO_EXTERNAL_NETWORK');
    results.push({name,status:'PASS',viewport,checks,api:'MOCKED',realPwaWorktree:root});
  } catch(error) { await screenshot('FAILURE').catch(()=>{}); results.push({name,status:'FAIL',checks,reason:error.stack}); process.exitCode=1; }
  finally { writeFileSync(join(output,`${name}-console-network.json`),JSON.stringify(log,null,2)); await context.tracing.stop({path:join(output,`${name}-trace.zip`)}); await context.close(); }
}
await browser.close(); writeFileSync(join(output,'results.json'),JSON.stringify(results,null,2)); console.log(JSON.stringify(results));
