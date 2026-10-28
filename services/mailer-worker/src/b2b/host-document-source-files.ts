import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {mailerRuntimeTls} from './runtime-config';
import {MailerReaderToken} from './host-reader-token';
import {MailerOwnerDocumentSource} from './host-document-source';
/** Separate, explicit builtin metadata. Injected owner ports keep their existing
 * runtime schema. This loader never discovers credentials or reads other RUCs. */
export function createMountedMailerDocumentSource(root:string,identityOrigin:string,identity:B2bPrivateHttp,billing:B2bPrivateHttp){
 let secret:Buffer|undefined;
 try{
  const files=new B2bRuntimeFiles(root),m=files.metadata('mailer-artifacts.json');
  if(Object.keys(m).sort().join(',')!=='clientId,environment,fiscalOrigin,identityServerSha256,schemaVersion'||m.schemaVersion!=='factuez.b2b.mailer-artifacts.v1'||m.environment!=='BETA')throw Error();
  const fiscalOrigin=new URL(m.fiscalOrigin);
  if(fiscalOrigin.protocol!=='https:'||fiscalOrigin.pathname!=='/'||fiscalOrigin.username||fiscalOrigin.password||fiscalOrigin.hash||fiscalOrigin.search)throw Error();
  const tls=(p:string)=>mailerRuntimeTls({ca:files.publicPem(p+'-ca.pem'),cert:files.publicPem(p+'.crt'),key:files.privatePem(p+'.key')});
  secret=files.secretBytes('reader-secret.bin');
  const reader=new MailerReaderToken(identityOrigin,tls('reader-token'),m.identityServerSha256,m.clientId,secret);
  try{return new MailerOwnerDocumentSource(billing,new B2bPrivateHttp(fiscalOrigin.origin,tls('fiscal')),identity,new B2bPrivateHttp(identityOrigin,tls('email-worker')),reader);}
  catch{reader.close();throw Error();}
 }catch{throw Error('B2B_MAILER_ARTIFACT_SOURCE_CONFIGURATION_INVALID');}finally{secret?.fill(0);}
}
