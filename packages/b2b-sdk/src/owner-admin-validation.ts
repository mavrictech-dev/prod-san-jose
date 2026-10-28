import {isIP} from 'node:net';
import {snapshot} from './transport';
import * as w from './validation';
import * as v from './phase8-validation';
import type * as t from './owner-admin-types';
export const roles = ['ADMIN','STATION_MANAGER','CASHIER','TRACK_OPERATOR','AUDITOR'] as const;
const permissions = ['setup.manage','user.manage','role.manage','product.manage','series.manage','sunat.configure','document.issue','document.view','document.retry','document.email','shift.open','shift.close','report.view','report.export','audit.view'];
const seriesTypes = ['INVOICE','SALES_RECEIPT','CREDIT_NOTE','DEBIT_NOTE','DESPATCH_ADVICE'];
import {fail,fields,integer,id,equal,instant} from './phase8-validation';
function text(x:unknown,max:number):asserts x is string {v.text(x,max);}
type Row=Record<string,any>;
function exact(x:unknown,keys:readonly string[]):asserts x is Row {w.exact(x,keys);}
function bool(x:unknown){if(typeof x!=='boolean')fail();}
function count(x:unknown,min=0,max=2147483647){if(!integer(x,min,max))fail();}
function date(x:unknown){if(x!==null)instant(x);}
function nullable(x:unknown,max:number){if(x!==null)text(x,max);}
function str(x:unknown,max:number,empty=false){if(empty&&x==='')return;text(x,max);}
function list(x:unknown,max=1000):any[]{if(!Array.isArray(x)||x.length>max)fail();return x;}
function unique(x:unknown,check:(a:any)=>void,max=1000,min=0){const a=list(x,max);if(a.length<min||new Set(a).size!==a.length)fail();a.forEach(check);}
function choice(x:unknown,values:readonly unknown[]){if(!values.includes(x))fail();}
function revision(x:unknown,zero=false,request=false){count(x,zero?0:1,request?2147483646:2147483647);}
function email(x:unknown){text(x,254);if(typeof x!=='string'||!/^\S+@[^\s@]+\.[^\s@]+$/.test(x))fail();}
function ruc(x:unknown){if(typeof x!=='string'||!/^\d{11}$/.test(x))fail();}
function code(x:unknown){text(x,20);if(!/^[A-Z0-9_-]{2,20}$/i.test(x.trim()))fail();}
function series(x:unknown,type:unknown){choice(type,seriesTypes);text(x,4);if(!(type==='INVOICE'?/^F[A-Z0-9]{3}$/i:type==='SALES_RECEIPT'?/^B[A-Z0-9]{3}$/i:type==='DESPATCH_ADVICE'?/^T[A-Z0-9]{3}$/i:/^[FB][A-Z0-9]{3}$/i).test(x))fail();}
function track(x:unknown){if(x!==null)count(x,1,9999);}
function secret(x:unknown,max=512){text(x,max);}
function safeName(x:unknown,extension:RegExp){text(x,150);if(x!==x.trim()||/[<>:"/\\|?*%]/.test(x)||x.includes('..')||!extension.test(x))fail();}
function base64(x:unknown,max:number):Buffer {
  if(typeof x!=='string'||!x.length||x.length>Math.ceil(max/3)*4||x.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(x))fail();
  const bytes=Buffer.from(x,'base64');if(!bytes.length||bytes.length>max||bytes.toString('base64')!==x)fail();return bytes;
}
function settings(x:unknown){
  exact(x,['template','logoMode','logoWidthMm','logoAlignment','showBranchAddress','footerNote']);
  if(x.template!=='SAN_JOSE_V1')fail();choice(x.logoMode,['DEFAULT','CUSTOM','NONE']);count(x.logoWidthMm,20,60);choice(x.logoAlignment,['LEFT','CENTER']);bool(x.showBranchAddress);str(x.footerNote,160,true);if(/[<>]/.test(x.footerNote))fail();
}
function draft(x:unknown){
  fields(x,['settings','logoUpload'],['settings']);if(x.settings!==null)settings(x.settings);
  if(x.logoUpload!==undefined){
    if(x.settings?.logoMode!=='CUSTOM')fail();exact(x.logoUpload,['mediaType','base64']);choice(x.logoUpload.mediaType,['image/png','image/jpeg','image/webp']);
    const b=base64(x.logoUpload.base64,256*1024),m=x.logoUpload.mediaType;
    if(m==='image/png'?!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):m==='image/jpeg'?b.length<3||b[0]!==255||b[1]!==216||b[2]!==255:b.length<12||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP')fail();
  }
}
function issuerInput(p:Row,create:boolean){
  for(const [k,max] of [['legalName',200],['taxAddress',300]] as const)if(create||k in p)text(p[k],max);
  if(create||'ubigeo'in p)if(typeof p.ubigeo!=='string'||!/^\d{6}$/.test(p.ubigeo))fail();
  for(const [k,max]of [['tradeName',200],['phone',40]]as const)if(k in p&&p[k]!=='')nullable(p[k],max);
  if('contactEmails'in p)list(p.contactEmails,10).forEach(email);if('active'in p)bool(p.active);
}
function masterInput(p:Row){if('code'in p)code(p.code);if('name'in p)text(p.name,120);if('address'in p&&p.address!=='')nullable(p.address,300);if('trackNumber'in p)track(p.trackNumber);if('active'in p)bool(p.active);}
function accessInput(p:Row,b:t.OwnerAdminBinding){
  if('roles'in p)unique(p.roles,r=>choice(r,roles),5,1);
  for(const [key,target]of [['branchIds',b.branchId],['emissionPointIds',b.pointId],['series',b.seriesId]]as const)if(key in p)unique(p[key],x=>{id(x);if(x!==target)fail();},1);
  if('active'in p)bool(p.active);
}
/** Snapshot the complete call before its first await; accessors and proxies never execute. */
export function request<A extends t.OwnerAdminAction>(action:A,binding:t.OwnerAdminBinding,body?:unknown,target?:unknown,page?:unknown){
  return v.input(()=>{
    const large=['PRINT_SAVE','PRINT_PREVIEW','FISCAL_SAVE','SMTP_SAVE'].includes(action);
    const args=snapshot({binding,...(body===undefined?{}:{body}),...(target===undefined?{}:{target}),...(page===undefined?{}:{page})},large?1024*1024:128*1024);
    const b=v.binding(args.binding),p:any=args.body;let pathId:string|undefined;
    if(action==='USERS_UPDATE'){id(args.target);pathId=args.target as string;}
    else if(action==='ROLES_UPDATE'){choice(args.target,roles);if(args.target==='ADMIN')fail();pathId=args.target as string;}
    else if(target!==undefined)fail();
    if(action==='ISSUER_UPDATE')pathId=String(b.issuerId);
    if(['BRANCH_UPDATE','POINT_CREATE'].includes(action))pathId=b.branchId;
    if(['POINT_UPDATE','SERIES_CREATE'].includes(action))pathId=b.pointId;
    if(action==='SERIES_UPDATE')pathId=b.seriesId;
    if(/^(PRINT|FISCAL|SMTP)_/.test(action))pathId=String(b.issuerId);
    if(action==='FISCAL_AUDIT'){if(typeof args.page!=='string'||!/^[1-9]\d{0,5}$/.test(args.page))fail();}
    else if(args.page!==undefined)fail();
    if(['MASTERS_READ','USERS_LIST','ROLES_LIST','PRINT_READ','FISCAL_READ','FISCAL_AUDIT','SMTP_READ'].includes(action)){
      if(p!==undefined)fail();
    }else switch(action){
      case 'ISSUER_CREATE':fields(p,['ruc','legalName','taxAddress','ubigeo','tradeName','phone','contactEmails'],['ruc','legalName','taxAddress','ubigeo']);ruc(p.ruc);issuerInput(p,true);break;
      case 'ISSUER_UPDATE':fields(p,['expectedRevision','legalName','taxAddress','ubigeo','tradeName','phone','contactEmails','active'],['expectedRevision']);revision(p.expectedRevision,false,true);issuerInput(p,false);break;
      case 'BRANCH_CREATE':fields(p,['companyId','code','name','address'],['companyId','code','name']);if(p.companyId!==b.issuerId)fail();masterInput(p);break;
      case 'BRANCH_UPDATE':fields(p,['expectedRevision','code','name','address','active'],['expectedRevision']);revision(p.expectedRevision,false,true);masterInput(p);break;
      case 'POINT_CREATE':fields(p,['code','name','invoiceSeries','receiptSeries','address','trackNumber'],['code','name','invoiceSeries','receiptSeries']);masterInput(p);series(p.invoiceSeries,'INVOICE');series(p.receiptSeries,'SALES_RECEIPT');break;
      case 'POINT_UPDATE':fields(p,['expectedRevision','code','name','address','trackNumber','active'],['expectedRevision']);revision(p.expectedRevision,false,true);masterInput(p);break;
      case 'SERIES_CREATE':exact(p,['documentType','series']);series(p.series,p.documentType);break;
      case 'SERIES_UPDATE':exact(p,['expectedRevision','active']);revision(p.expectedRevision,false,true);bool(p.active);break;
      case 'USERS_CREATE':exact(p,['username','fullName','password','roles','branchIds','emissionPointIds','series']);text(p.username,80);if(!/^[a-zA-Z0-9._-]{3,80}$/.test(p.username.trim()))fail();text(p.fullName,160);secret(p.password,200);if(p.password.length<10)fail();accessInput(p,b);break;
      case 'USERS_UPDATE':fields(p,['active','roles','branchIds','emissionPointIds','series'],[]);if(!Object.keys(p).length)fail();accessInput(p,b);break;
      case 'ROLES_UPDATE':exact(p,['permissions','expectedPermissions']);for(const k of ['permissions','expectedPermissions'])unique(p[k],x=>choice(x,permissions),permissions.length);break;
      case 'PRINT_SAVE':fields(p,['expectedRevision','settings','logoUpload'],['expectedRevision','settings']);revision(p.expectedRevision,true,true);draft(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='expectedRevision')));break;
      case 'PRINT_PREVIEW':fields(p,['documentTypeCode','format','draft'],['documentTypeCode','format']);choice(p.documentTypeCode,['01','03','07','08','09','31']);choice(p.format,['a4','ticket']);if(p.draft!==undefined)draft(p.draft);break;
      case 'FISCAL_SAVE':
        fields(p,['expectedRevision','certificate','sol','gre'],['expectedRevision']);revision(p.expectedRevision,true,true);if(!['certificate','sol','gre'].some(k=>k in p))fail();
        if(p.certificate!==undefined){exact(p.certificate,['fileName','base64','password']);safeName(p.certificate.fileName,/\.(p12|pfx)$/i);base64(p.certificate.base64,512*1024);secret(p.certificate.password);}
        if(p.sol!==undefined){exact(p.sol,['username','password']);secret(p.sol.username,80);if(!/^[A-Za-z0-9._-]{3,80}$/.test(p.sol.username))fail();secret(p.sol.password);}
        if(p.gre!==undefined){exact(p.gre,['clientId','clientSecret']);secret(p.gre.clientId,160);secret(p.gre.clientSecret);}break;
      case 'SMTP_SAVE':{
        fields(p,['expectedRevision','settings','credentials'],['expectedRevision','settings']);revision(p.expectedRevision,true,true);const s=p.settings;
        fields(s,['host','port','tlsMode','fromName','fromAddress','replyTo'],['host','port','tlsMode','fromName','fromAddress']);text(s.host,253);
        if(isIP(s.host)||!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s.host)||/(^|\.)(localhost|local|localdomain|internal|invalid|test|onion|home|lan)$/.test(s.host)||/^(localhost|metadata)(\.|$)/.test(s.host))fail();
        choice(s.port,[465,587]);if(s.tlsMode!==(s.port===465?'TLS':'STARTTLS'))fail();text(s.fromName,160);if(s.fromName!==s.fromName.trim())fail();
        for(const a of [s.fromAddress,...(s.replyTo==null?[]:[s.replyTo])]){email(a);if(!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(a))fail();}
        if(p.credentials!==undefined){exact(p.credentials,['username','password']);secret(p.credentials.username,254);if(p.credentials.username!==p.credentials.username.trim())fail();secret(p.credentials.password);}break;
      }
      default:fail();
    }
    return {binding:b,body:p,ids:pathId===undefined?[]:[pathId],query:{...v.bindingQuery(b),...(action==='FISCAL_AUDIT'?{page:args.page as string}:{})}};
  });
}
const issuerKeys=['id','ruc','legalName','tradeName','taxAddress','ubigeo','phone','contactEmails','environment','active','revision'];
const branchKeys=['id','companyId','code','name','address','active','revision'];
const pointKeys=[...branchKeys,'branchId','trackNumber'];
const seriesKeys=['id','companyId','emissionPointId','documentType','series','nextNumber','active','revision'];
function issuer(x:unknown){exact(x,issuerKeys);count(x.id,1);ruc(x.ruc);issuerInput(x,true);if(x.environment!=='BETA')fail();bool(x.active);revision(x.revision);}
function branch(x:unknown,catalog=false){const keys=[...branchKeys,...(catalog?['effectiveActive','pointCount','openShiftCount']:[])];fields(x,keys,keys.filter(k=>k!=='address'));id(x.id);count(x.companyId,1);code(x.code);text(x.name,120);if('address'in x)nullable(x.address,300);bool(x.active);revision(x.revision);if(catalog){bool(x.effectiveActive);count(x.pointCount);count(x.openShiftCount);if(x.effectiveActive&&!x.active)fail();}}
function point(x:unknown,catalog=false){const keys=[...pointKeys,...(catalog?['effectiveActive','openShiftCount']:[])];fields(x,keys,keys.filter(k=>!['address','trackNumber'].includes(k)));branch(Object.fromEntries(Object.entries(x).filter(([k])=>branchKeys.includes(k))));id(x.branchId);if('trackNumber'in x)track(x.trackNumber);if(catalog){bool(x.effectiveActive);count(x.openShiftCount);if(x.effectiveActive&&!x.active)fail();}}
function counter(x:unknown,catalog=false){exact(x,[...seriesKeys,...(catalog?['effectiveActive','documentCount','canRename']:[])]);id(x.id);count(x.companyId,1);id(x.emissionPointId);series(x.series,x.documentType);if(typeof x.nextNumber!=='string'||!/^[1-9]\d{0,19}$/.test(x.nextNumber))fail();bool(x.active);revision(x.revision);if(catalog){bool(x.effectiveActive);count(x.documentCount);bool(x.canRename);if(x.effectiveActive&&!x.active||x.canRename!==(x.nextNumber==='1'&&x.documentCount===0))fail();}}
function sameIssuer(x:Row,b:t.OwnerAdminBinding){if(x.companyId!==b.issuerId)fail();}
function sameRuc(x:Row,b:t.OwnerAdminBinding){if(x.ruc!==b.issuerRuc)fail();}
function user(x:unknown,editable=false){
  exact(x,['id','username','fullName','active','lastLoginAt','roles','branchIds','emissionPointIds','series',...(editable?['editable']:[])]);
  id(x.id);text(x.username,80);if(!/^[a-zA-Z0-9._-]{3,80}$/.test(x.username))fail();text(x.fullName,160);bool(x.active);date(x.lastLoginAt);
  const codes:string[]=[];for(const r of list(x.roles,5)){exact(r,['code','name']);choice(r.code,roles);text(r.name,100);codes.push(r.code);}if(!codes.length||new Set(codes).size!==codes.length)fail();
  for(const k of ['branchIds','emissionPointIds','series'])unique(x[k],id,500);if(editable)bool(x.editable);
}
function role(x:unknown){exact(x,['id','code','name','description','permissions','editable','assignable']);id(x.id);choice(x.code,roles);text(x.name,100);nullable(x.description,8192);unique(x.permissions,p=>choice(p,permissions),permissions.length);bool(x.editable);bool(x.assignable);if(x.code==='ADMIN'&&x.editable)fail();}
function fiscal(x:unknown,b:t.OwnerAdminBinding){
  exact(x,['ruc','environment','revision','updatedAt','solConfigured','greConfigured','fiscalTransmission','certificate']);sameRuc(x,b);if(x.environment!=='BETA'||x.fiscalTransmission!==false)fail();revision(x.revision,true);date(x.updatedAt);bool(x.solConfigured);bool(x.greConfigured);
  const c=x.certificate;exact(c,['configured','fingerprint','expiresAt','selfSigned','expired','trustAndRucVerified']);bool(c.configured);bool(c.expired);if(c.trustAndRucVerified!==false)fail();
  if(c.fingerprint!==null&&!v.hash(c.fingerprint))fail();date(c.expiresAt);if(c.selfSigned!==null)bool(c.selfSigned);
  if(!c.configured&&(c.fingerprint!==null||c.expiresAt!==null||c.selfSigned!==null||c.expired))fail();
  if(c.configured&&(c.fingerprint===null||c.expiresAt===null||c.selfSigned===null))fail();
}
function smtp(x:unknown,b:t.OwnerAdminBinding){
  exact(x,['companyId','ruc','state','revision','updatedAt','configured','credentialsConfigured','storageReady','encryption','integrity','approvedHostListConfigured','hostnameApproved','networkAttempted','dnsValidated','smtpAuthenticationVerified','deliveredToClient','readyToSend']);sameIssuer(x,b);sameRuc(x,b);
  if(x.state!=='EXTERNAL_SMTP_DISABLED')fail();revision(x.revision,true);date(x.updatedAt);choice(x.encryption,['READY','MISSING','INVALID']);choice(x.integrity,['NOT_CONFIGURED','NOT_CHECKED','VALID','INVALID']);
  for(const k of ['configured','credentialsConfigured','storageReady','approvedHostListConfigured','hostnameApproved'])bool(x[k]);
  for(const k of ['networkAttempted','dnsValidated','smtpAuthenticationVerified','deliveredToClient','readyToSend'])if(x[k]!==false)fail();
  if(x.credentialsConfigured&&(!x.configured||x.encryption!=='READY'||x.integrity!=='VALID'))fail();
}
/** Exact per-action allowlists reject secrets even when nested in otherwise valid metadata. */
export function response<T,A extends t.OwnerAdminAction>(value:unknown,action:A,call:ReturnType<typeof request>):t.OwnerAdminResponse<T,A>{
  exact(value,['schemaVersion','action','binding','environment','candidateOnly','fiscalExecutionEnabled','data']);const b=call.binding,p=call.body;
  if(value.schemaVersion!=='factuez.b2b.owner-admin.v1'||value.action!==action||value.environment!=='BETA'||value.candidateOnly!==true||value.fiscalExecutionEnabled!==false||!equal(v.binding(value.binding),b))fail();
  const d=value.data;
  switch(action){
    case 'MASTERS_READ':{
      exact(d,['version','capabilities','companies','branches','emissionPoints','series']);if(d.version!=='factuez.station-admin.v1')fail();exact(d.capabilities,['betaOnly','softDelete','counterEditing']);if(d.capabilities.betaOnly!==true||d.capabilities.softDelete!==true||d.capabilities.counterEditing!==false)fail();
      for(const x of list(d.companies,1)){issuer(x);if(x.id!==b.issuerId)fail();sameRuc(x,b);}
      for(const x of list(d.branches,1)){branch(x,true);sameIssuer(x,b);if(x.id!==b.branchId)fail();}
      for(const x of list(d.emissionPoints,1)){point(x,true);sameIssuer(x,b);if(x.id!==b.pointId||x.branchId!==b.branchId)fail();}
      for(const x of list(d.series,1)){counter(x,true);sameIssuer(x,b);if(x.id!==b.seriesId||x.emissionPointId!==b.pointId||x.documentType!==(b.documentType==='01'?'INVOICE':'SALES_RECEIPT'))fail();}
      break;
    }
    case 'ISSUER_CREATE':case 'ISSUER_UPDATE':issuer(d);if(action==='ISSUER_UPDATE'?(d.id!==b.issuerId||d.ruc!==b.issuerRuc):d.ruc!==p.ruc)fail();break;
    case 'BRANCH_CREATE':case 'BRANCH_UPDATE':branch(d);sameIssuer(d,b);if(action==='BRANCH_UPDATE'&&d.id!==b.branchId)fail();break;
    case 'POINT_CREATE':{
      exact(d,['id','companyId','branchId','code','name','active','revision','series']);id(d.id);sameIssuer(d,b);if(d.branchId!==b.branchId)fail();code(d.code);text(d.name,120);bool(d.active);revision(d.revision);
      const rows=list(d.series,2);if(rows.length!==2)fail();const ids=new Set(),types=new Set();
      for(const x of rows){exact(x,['id','documentType','series','revision']);id(x.id);series(x.series,x.documentType);revision(x.revision);if(ids.has(x.id)||types.has(x.documentType)||x.series!==(x.documentType==='INVOICE'?p.invoiceSeries.toUpperCase():x.documentType==='SALES_RECEIPT'?p.receiptSeries.toUpperCase():undefined))fail();ids.add(x.id);types.add(x.documentType);}break;
    }
    case 'POINT_UPDATE':point(d);sameIssuer(d,b);if(d.id!==b.pointId||d.branchId!==b.branchId)fail();break;
    case 'SERIES_CREATE':case 'SERIES_UPDATE':counter(d);sameIssuer(d,b);if(d.emissionPointId!==b.pointId||action==='SERIES_UPDATE'&&(d.id!==b.seriesId||d.documentType!==(b.documentType==='01'?'INVOICE':'SALES_RECEIPT'))||action==='SERIES_CREATE'&&(d.documentType!==p.documentType||d.series!==p.series.toUpperCase()))fail();break;
    case 'USERS_LIST':{const seen=new Set();for(const x of list(d)){user(x,true);if(seen.has(x.id))fail();seen.add(x.id);}break;}
    case 'USERS_CREATE':case 'USERS_UPDATE':user(d);if(action==='USERS_UPDATE'&&d.id!==call.ids[0]||action==='USERS_CREATE'&&(d.username!==p.username.trim()||d.fullName!==p.fullName.trim()))fail();for(const k of ['roles','branchIds','emissionPointIds','series'])if(p[k]!==undefined){const actual=k==='roles'?d.roles.map((x:Row)=>x.code):d[k];if(!equal([...actual].sort(),[...p[k]].sort()))fail();}break;
    case 'ROLES_LIST':{const seen=new Set();for(const x of list(d,5)){role(x);if(seen.has(x.code))fail();seen.add(x.code);}break;}
    case 'ROLES_UPDATE':exact(d,['code','permissions','affectedUsers']);if(d.code!==call.ids[0])fail();unique(d.permissions,x=>choice(x,permissions),permissions.length);if(!equal([...d.permissions].sort(),[...p.permissions].sort()))fail();count(d.affectedUsers);break;
    case 'PRINT_READ':case 'PRINT_SAVE':
      exact(d,['version','companyId','ruc','branchId','revision','updatedAt','source','storageReady','fiscalTransmission','override','effective','logoConfigured']);sameIssuer(d,b);sameRuc(d,b);if(d.version!=='factuez.print-settings.v1'||d.branchId!==b.branchId||d.fiscalTransmission!==false)fail();revision(d.revision,true);date(d.updatedAt);choice(d.source,['BRANCH','ISSUER','DEFAULT']);bool(d.storageReady);bool(d.logoConfigured);if(d.override!==null)settings(d.override);settings(d.effective);break;
    case 'PRINT_PREVIEW':{
      exact(d,['base64','contentType','fileName']);if(d.contentType!=='application/pdf')fail();safeName(d.fileName,/\.pdf$/i);const bytes=base64(d.base64,1_500_000);if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')fail();
      return {...value,data:{bytes,contentType:'application/pdf',fileName:d.fileName}} as t.OwnerAdminResponse<T,A>;
    }
    case 'FISCAL_READ':case 'FISCAL_SAVE':fiscal(d,b);break;
    case 'FISCAL_AUDIT':{
      exact(d,['ruc','environment','page','pageSize','total','items']);sameRuc(d,b);if(d.environment!=='BETA'||d.page!==Number(call.query.page)||d.pageSize!==10)fail();count(d.total);const rows=list(d.items,10);if(rows.length!==Math.min(10,Math.max(0,d.total-(d.page-1)*10)))fail();const seen=new Set();let previous:string|undefined;
      for(const x of rows){exact(x,['id','actorId','fields','revision','occurredAt']);id(x.id);id(x.actorId);unique(x.fields,f=>choice(f,['certificate','sol','gre','certificate.remove','sol.remove','gre.remove']),3,1);revision(x.revision);instant(x.occurredAt);if(seen.has(x.id)||previous!==undefined&&x.occurredAt>previous)fail();seen.add(x.id);previous=x.occurredAt;}break;
    }
    case 'SMTP_READ':case 'SMTP_SAVE':smtp(d,b);break;
    default:fail();
  }
  if(p?.expectedRevision!==undefined&&d.revision!==p.expectedRevision+1)fail();
  if(p?.active!==undefined&&d.active!==p.active)fail();
  return value as t.OwnerAdminResponse<T,A>;
}


