/** Loopback-only UI fixture. Never a replacement Identity/Billing service. */
const {createServer}=require('node:http');
if(process.argv.slice(2).join(' ')!=='--isolated-synthetic-only')throw new Error('Use --isolated-synthetic-only');
const origin='http://127.0.0.1:3104',uuid='00000000-0000-4000-8000-000000000900';
const allowed=new Map([
  ['GET /api/v1/auth/browser-session',()=>({accessToken:'SYNTHETIC-NOT-A-JWT',user:{sub:uuid,username:'qa.visual',fullName:'Revisor ficticio QA',roles:['ADMIN'],permissions:['sunat.configure','report.view','document.view'],scope:{kind:'GLOBAL'},exp:Math.floor(Date.now()/1000)+3600},idleExpiresAt:Date.now()+1800000,serverNow:Date.now()})],
  ['POST /api/v1/auth/browser-session/activity',()=>({idleExpiresAt:Date.now()+1800000,serverNow:Date.now()})],
  ['GET /api/v1/documents/catalog/issuance',()=>({companies:[{id:1,legalName:'EMISOR FICTICIO QA',ruc:'00000000001',environment:'BETA'}],capabilities:{demoData:true,fiscalTransmission:false},branches:[],emissionPoints:[],products:[]})],
]);
let requests=0,blocked=0;
const server=createServer((req,res)=>{
  if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);return res.end();}
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,Accept');res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  requests++;const handler=allowed.get(`${req.method} ${req.url}`);
  if(!handler){blocked++;res.writeHead(404);return res.end('Synthetic fixture: route blocked');}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(handler()));
});
server.on('upgrade',(_req,socket)=>{socket.destroy();});
server.listen(3174,'127.0.0.1',()=>console.log('Synthetic UI fixture on 127.0.0.1:3174. No database, secrets, fiscal endpoints or outgoing requests.'));
process.on('SIGINT',()=>{server.close(()=>{console.log(JSON.stringify({syntheticRequests:requests,blockedRequests:blocked,fiscalWrites:0,outgoingRequests:0}));process.exit(0);});});
