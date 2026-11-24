'use strict';
// Browser-only synthetic API/session on loopback; proxies UI assets to a local Next server.
// No database, external service, official request, credential read or customer data.
if(process.argv[2]!=='--synthetic-only')throw Error('SYNTHETIC_ONLY_REQUIRED');
const http=require('node:http'),{createRequire}=require('node:module'),{resolve}=require('node:path');
const {PermissionCodes,DEFAULT_TAX_POLICY}=createRequire(resolve('packages/contracts/package.json'))('./dist/index.js');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),branch=id(1),point=id(2),category=id(3),product=id(4),counter=id(5);
const companies=[{id:1,ruc:'20100070970',legalName:'SYNTHETIC EMISOR COSTA',environment:'PRODUCTION',active:true,revision:1,taxAddress:'SYNTHETIC ADDRESS',ubigeo:'150101',contactEmails:[]},{id:2,ruc:'20131312955',legalName:'SYNTHETIC EMISOR SELVA',environment:'BETA',active:true,revision:1,taxAddress:'SYNTHETIC ADDRESS',ubigeo:'160101',contactEmails:[]}];
const branches=[{id:branch,companyId:1,code:'SYN1',name:'SYNTHETIC SEDE COSTA',active:true,revision:1,establishmentCode:'0001'},{id:id(11),companyId:2,code:'SYN2',name:'SYNTHETIC SEDE SELVA',active:true,revision:1,establishmentCode:'0001'}];
const points=[{id:point,companyId:1,branchId:branch,code:'SYN-P1',name:'SYNTHETIC PUNTO',active:true,revision:1,series:[{id:counter,series:'F001',documentType:'INVOICE'}]},{id:id(12),companyId:2,branchId:id(11),code:'SYN-P2',name:'SYNTHETIC PUNTO SELVA',active:true,revision:1,series:[]}];
const products=[{id:product,sku:'SYN-NIU',description:'SYNTHETIC PRODUCTO',category:'Mercadería',categoryId:category,unitCode:'NIU',taxAffectationCode:'10',sunatProductCode:null,defaultUnitPrice:'118.00',active:true,updatedAt:'2026-11-23T12:00:00.000Z'}];
let policyRevision=1,policy={...DEFAULT_TAX_POLICY,region:'SELVA',allowExempt:true,allowUnaffected:true},failProduct=false;
const user={sub:id(9),username:'SYNTHETIC',fullName:'SYNTHETIC ADMIN',roles:['ADMIN'],permissions:Object.values(PermissionCodes),scope:{kind:'GLOBAL'},authVersion:1};
function policyView(companyId,branchId){const p=companyId===2?policy:DEFAULT_TAX_POLICY;return {companyId,branchId:branchId||null,revision:policyRevision,rucRevision:1,branchRevision:branchId?1:0,overridden:companyId===2,source:companyId===2?'RUC':'DEFAULT',policy:p,inherited:p};}
async function api(req,res,url){const chunks=[];for await(const c of req)chunks.push(c);let body={};try{if(chunks.length)body=JSON.parse(Buffer.concat(chunks));}catch{}res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');const send=(value,status=200)=>{res.statusCode=status;res.end(JSON.stringify(value));};const path=url.pathname;
 if(path==='/api/v1/auth/browser-session'||path==='/api/v1/auth/browser-session/continue')return send({accessToken:'SYNTHETIC_SESSION',user,idleExpiresAt:Date.now()+1800000,serverNow:Date.now()});
 if(path==='/api/v1/documents/catalog/issuance')return send({companies,branches,emissionPoints:points,products});
 if(path==='/api/v1/stations/admin/catalog')return send({version:'factuez.station-admin.v1',capabilities:{betaOnly:false,softDelete:true,counterEditing:false},companies,branches,emissionPoints:points,series:[{...points[0].series[0],companyId:1,emissionPointId:point,nextNumber:'1',active:true,revision:1}]});
 if(path==='/api/v1/stations/product-categories')return send([{id:category,name:'Mercadería',active:true,revision:1}]);
 if(path==='/api/v1/stations/product-units')return send([{code:'NIU',description:'Unidad',active:true,revision:1},{code:'GLL',description:'Galón',active:true,revision:1}]);
 if(path==='/api/v1/stations/products'&&req.method==='GET')return send(products);
 if(path.startsWith('/api/v1/stations/products')&&req.method!=='GET'){if(failProduct||!body.sku)return send({message:'El SKU ya está registrado. Sus valores se conservan.'},409);return send({...body,id:product,updatedAt:new Date().toISOString()},201);}
 if(path.endsWith('/tax-policy')){const companyId=Number(path.split('/')[5]);if(req.method==='PUT'){policy={...body.policy};policyRevision++;}return send(policyView(companyId,url.searchParams.get('branchId')));}
 if(path.endsWith('/product-taxes'))return send([]);
 if(path.includes('/product-taxes/'))return send({revision:2});
 if(path.endsWith('/effective-products'))return send({products:products.map(p=>({...p,igvRate:'18.00',taxAllowed:true}))});
 if(path==='/api/v1/users')return send([{id:user.sub,fullName:user.fullName,active:true}]);
 if(path==='/api/v1/production-guides/capabilities')return send({implemented:true,installed:true,enabled:false,ready:false,companyId:url.searchParams.get('pointId')===id(12)?2:1,issuerRuc:companies[0].ruc,pointRevision:1,establishmentCode:'0001',series:[],fiscal:{credentialRevision:0,catalogue:null},blockers:['Transmisión GRE pendiente de activación explícita','Configure credenciales GRE/SOL y certificado','Registre el catálogo revisado del RUC y una concesión por actor']});
 if(path==='/api/v1/production-guides')return send({items:[],nextCursor:null});
 if(path.startsWith('/api/v1/production-guides/series/point/'))return send({series:[],serverEnabled:false});
 if(path.endsWith('/guides/catalogue'))return send({issuerRuc:companies[0].ruc,revision:0,catalogue:null,availableGoods:[{code:'SYN-NIU',description:'SYNTHETIC PRODUCTO',unitCode:'NIU'}]});
 if(/^\/api\/v1\/setup\/sunat\/\d+\/(BETA|PRODUCTION)$/.test(path))return send({ruc:companies[0].ruc,environment:path.endsWith('PRODUCTION')?'PRODUCTION':'BETA',emissionEnvironment:'PRODUCTION',revision:1,certificate:{configured:false,fingerprint:null,expiresAt:null,selfSigned:null,expired:false},solConfigured:false,greConfigured:false,fiscalTransmission:false});
 if(path.endsWith('/dispatch'))return send({ruc:companies[0].ruc,environment:'PRODUCTION',profile:'01-PEN-0101-IGV18-v1',supportedDocumentTypes:['01'],serverEnabled:false,version:0,credentialRevision:1,enabled:false});
 if(path.endsWith('/authorization'))return send({issuerRuc:companies[0].ruc,profile:'07-08-ON-01-PEN-0101-IGV18-v1',version:0,credentialRevision:1,serverEnabled:false,enabled:false,supportedDocumentTypes:['07','08']});
 if(path.endsWith('/readiness'))return send({ruc:companies[0].ruc,environment:'PRODUCTION',revision:1,checks:[],blockers:['SYNTHETIC: configuración pendiente']});
 if(path.endsWith('/audit'))return send({items:[],page:1,pageSize:10,total:0});
 if(path==='/api/v1/setup/sunat/reference'){const {catalogGreOpenApiPaths}=createRequire(resolve('packages/contracts/package.json'))('./dist/index.js');return send({openapi:'3.1.0',info:{title:'SYNTHETIC · API nativa',version:'1'},paths:catalogGreOpenApiPaths()});}
 if(path==='/api/v1/qa/product-conflict'){failProduct=body.enabled===true;return send({synthetic:true});}
 return send({message:'SYNTHETIC: ruta no usada por esta verificación'},404);
}
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1:8760');if(url.pathname.startsWith('/api/v1/'))return void api(req,res,url).catch(()=>{res.statusCode=500;res.end('{}');});const proxy=http.request({hostname:'127.0.0.1',port:8761,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:8761'}},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});proxy.on('error',()=>{res.statusCode=503;res.end('Synthetic UI server starting');});req.pipe(proxy);});
server.listen(8760,'127.0.0.1',()=>console.log('SYNTHETIC_UI_PROXY http://127.0.0.1:8760'));process.on('SIGINT',()=>server.close(()=>process.exit(0)));
