import {X509Certificate} from 'node:crypto';
import type {B2bRuntimeFiles} from './b2b-runtime-files';
export interface B2bPostgresOptions {
 host:string;port:number;user:string;database:string;password:string;
 ssl:{ca:Buffer;rejectUnauthorized:true;minVersion:'TLSv1.2'};
 max:4;connectionTimeoutMillis:3000;statement_timeout:10000;idleTimeoutMillis:30000;
}
export function mountedB2bPostgres(files:Pick<B2bRuntimeFiles,'publicPem'|'secretBytes'>,metadata:{host:string;port:number;user:string;name:string;passwordFile:string}){
 if(!metadata||Object.keys(metadata).sort().join(',')!=='host,name,passwordFile,port,user'||!/^[a-z][a-z0-9-]{0,63}\.bin$/.test(metadata.passwordFile)||!metadata.name.endsWith('_beta'))throw Error('B2B_POSTGRES_MOUNT_REQUIRED');
 const password=files.secretBytes(metadata.passwordFile);
 try{return b2bPostgresOptions({host:metadata.host,port:metadata.port,user:metadata.user,database:metadata.name,password:password.toString('utf8').trim(),
  ssl:{ca:files.publicPem('database-ca.pem'),rejectUnauthorized:true,minVersion:'TLSv1.2'},max:4,connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000});}
 finally{password.fill(0);}
}
/** Explicit owner-only PG configuration. Never a URL whose query can override TLS. */
export function b2bPostgresOptions(value:B2bPostgresOptions):B2bPostgresOptions {
 try{
  if(!value||Object.keys(value).sort().join(',')!=='connectionTimeoutMillis,database,host,idleTimeoutMillis,max,password,port,ssl,statement_timeout,user'||
   typeof value.host!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value.host)||!Number.isInteger(value.port)||value.port<1||value.port>65535||
   !/^[a-z][a-z0-9_]{0,62}$/.test(value.database)||!/^[a-z][a-z0-9_]{0,62}$/.test(value.user)||typeof value.password!=='string'||!value.password||Buffer.byteLength(value.password)>4096||/[\r\n\0]/.test(value.password)||
   !value.ssl||Object.keys(value.ssl).sort().join(',')!=='ca,minVersion,rejectUnauthorized'||!Buffer.isBuffer(value.ssl.ca)||value.ssl.ca.length>65536||
   value.ssl.rejectUnauthorized!==true||value.ssl.minVersion!=='TLSv1.2'||value.max!==4||value.connectionTimeoutMillis!==3000||value.statement_timeout!==10000||value.idleTimeoutMillis!==30000)throw Error();
  const ca=new X509Certificate(value.ssl.ca);if(!ca.ca||Date.parse(ca.validTo)<=Date.now()||Date.parse(ca.validFrom)>Date.now())throw Error();
  return {...value,ssl:{...value.ssl,ca:Buffer.from(value.ssl.ca)}};
 }catch{throw Error('B2B_POSTGRES_VERIFIED_TLS_REQUIRED');}
}
