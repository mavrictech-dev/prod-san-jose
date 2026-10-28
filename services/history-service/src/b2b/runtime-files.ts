import {PrismaPg} from '@prisma/adapter-pg';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {b2bPostgresOptions,type B2bPostgresOptions} from '@factuez/service-access/dist/b2b-postgres-options';
import {historyRuntimeConfig,historyRuntimeTls} from './runtime-config';
/** Fixed QA names are intentionally NOT converted to a generic *_beta DB.
 * Use the shared low-level verifier: mountedB2bPostgres's name convention is
 * incompatible with the original History QA attestation. */
export function loadB2bHistoryRuntimeMount(root:string){
 try{
  const files=new B2bRuntimeFiles(root),config=historyRuntimeConfig(files.metadata());
  const tls=(p:string)=>historyRuntimeTls({ca:files.publicPem(p+'-ca.pem'),cert:files.publicPem(p+'.crt'),key:files.privatePem(p+'.key')});
  const credentials={apiTls:tls('api'),controlTls:tls('operator')},identityTls=tls('identity');
  const password=files.secretBytes(config.database.passwordFile);let database:B2bPostgresOptions;
  try{database=b2bPostgresOptions({host:config.database.host,port:config.database.port,user:config.database.user,database:config.database.name,
   password:password.toString('utf8').trim(),ssl:{ca:files.publicPem('database-ca.pem'),rejectUnauthorized:true,minVersion:'TLSv1.2'},
   max:4,connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000});}finally{password.fill(0);}
  return {config,credentials,identityTls,database};
 }catch{throw Error('B2B_HISTORY_MOUNTED_CONFIGURATION_INVALID');}
}
/** PrismaPg owns the actual bounded pg.Pool; $disconnect disposes it. */
export function b2bHistoryPrismaAdapter(options:B2bPostgresOptions){
 const approved=b2bPostgresOptions(options);
 if(!/^factuez_history_qa_[a-f0-9]{10}(?:_restore)?$/.test(approved.database)||approved.user!=='history_reader_qa')throw Error('B2B_HISTORY_QA_DATABASE_REQUIRED');
 return new PrismaPg({...approved,options:'-c search_path=public'},{schema:'public'});
}
