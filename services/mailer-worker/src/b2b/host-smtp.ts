import {inspect} from 'node:util';
import {AccessError} from '@factuez/service-access';
import {validB2bBinding,type B2bBinding} from '@factuez/contracts/b2b-security';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {HttpB2bOwnerBinding} from '@factuez/service-access/dist/b2b-owner-administration';
import {Phase8AdminCapabilities,adminDigest,adminSnapshot,type Phase8AdminContextRequest,type Phase8AdminContextResolver,type Phase8AdminOwnerContext} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {SmtpConfigurationService} from '../smtp-configuration.service';
import {approvedHost,EXTERNAL_SMTP_STATE,parseSmtpInput,parseSmtpSettings,parseSmtpCredentials,smtpHostname,type CorporateSmtpConfiguration} from '../smtp-configuration.policy';
import type {SmtpIssuer,StoredSmtpConfiguration} from '../smtp-configuration.store';
import type {EmailDeliveryPgPool} from './email-deliveries.store';
import type {MailerSmtpOwnerResource} from './runtime';
import {MailerHostSmtpVault} from './host-smtp.crypto';
import {MailerHostSmtpStore} from './host-smtp.store';
import {mailerSmtpOwnerContextResolver} from './host-smtp.context';
/** Added by the capability resolver from its real operation binding, never HTTP metadata. */
export type MailerSmtpOwnerContext=Phase8AdminOwnerContext & {currentIssuerB2bOwnerBinding:B2bBinding};
export interface MailerSmtpOwnerOptions {
 pool:EmailDeliveryPgPool;key:Buffer;keyVersion:number;approvedHosts:readonly string[];
 database:{name:string;user:string};billingHttp:B2bPrivateHttp;
}
const denied=()=>new AccessError(403,'B2B_MAILER_SMTP_CAPABILITY_REQUIRED');
const unavailable=()=>new AccessError(503,'B2B_MAILER_SMTP_OWNER_UNAVAILABLE');
/** Nominal legacy service boundary only. Every reachable operation is overridden;
 * no legacy store/vault/transport constructor, environment or bearer path is used. */
class PreparedSmtpOwner extends SmtpConfigurationService {
 #actions:Pick<SmtpConfigurationService,'status'|'save'>;
 constructor(actions:Pick<SmtpConfigurationService,'status'|'save'>){super(undefined!,undefined!,undefined!);this.#actions=actions;}
 override status(companyId:string,handle:string|object){return this.#actions.status(companyId,handle);}
 override save(companyId:string,body:unknown,handle:string|object){return this.#actions.save(companyId,body,handle);}
 override async remove(_companyId:string,_body:unknown,_authorization:string):Promise<never>{throw denied();}
 override async audit(_companyId:string,_authorization:string,_page='1'):Promise<never>{throw denied();}
 override async dryRun(_companyId:string,_body:unknown,_authorization:string):Promise<never>{throw denied();}
 toJSON(){return {service:'PreparedSmtpOwner',profile:'PREPARED_ONLY'};}
 [inspect.custom](){return this.toJSON();}
}
class MailerHostSmtpResource implements MailerSmtpOwnerResource {
 #vault:MailerHostSmtpVault;#store:MailerHostSmtpStore;#hosts:readonly string[];#billing:HttpB2bOwnerBinding;
 #closed=false;#active=new Set<Promise<unknown>>();#closing?:Promise<void>;
 constructor(options:MailerSmtpOwnerOptions){
  if(!options||!(options.billingHttp instanceof B2bPrivateHttp)||!Array.isArray(options.approvedHosts)||!options.approvedHosts.length||options.approvedHosts.length>16||
   options.approvedHosts.some(h=>!smtpHostname(h))||new Set(options.approvedHosts).size!==options.approvedHosts.length)throw unavailable();
  this.#store=new MailerHostSmtpStore(options.pool,options.database);
  this.#billing=new HttpB2bOwnerBinding(options.billingHttp);this.#hosts=Object.freeze([...options.approvedHosts]);
  this.#vault=new MailerHostSmtpVault(options.key,options.keyVersion);
 }
 #run<T>(work:()=>Promise<T>):Promise<T>{
  if(this.#closed||this.#active.size>=16)return Promise.reject(unavailable());
  const pending=Promise.resolve().then(work);this.#active.add(pending);
  void pending.then(()=>this.#active.delete(pending),()=>this.#active.delete(pending));return pending;
 }
 createOwner(caps:Phase8AdminCapabilities):SmtpConfigurationService{
  if(this.#closed||!(caps instanceof Phase8AdminCapabilities))throw denied();
  const resolver=mailerSmtpOwnerContextResolver(caps);
  return new PreparedSmtpOwner({status:(id,handle)=>this.#statusFor(resolver,id,handle),save:(id,body,handle)=>this.#saveFor(resolver,id,body,handle)});
 }
 checkStorage(){return this.#run(()=>this.#store.checkStorage());}
 async #context(caps:Phase8AdminContextResolver,companyId:string,handle:string|object,action:Phase8AdminContextRequest['action'],payload:unknown){
  if(typeof handle!=='object'||handle===null||!(/^[1-9]\d{0,9}$/.test(companyId)))throw denied();
  const current=adminSnapshot(await caps.resolve(handle,{action,companyId,environment:'BETA',payload})) as MailerSmtpOwnerContext;
  const binding=current?.currentIssuerB2bOwnerBinding;
  if(!validB2bBinding(binding)||binding.environment!=='BETA'||String(binding.issuerId)!==companyId||current.environment!=='BETA'||
   current.issuer.companyId!==binding.issuerId||current.issuer.ruc!==binding.issuerRuc||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(current.actorId))throw denied();
  const owner=await this.#billing.revalidate(binding);
  if(adminDigest(owner.binding)!==adminDigest(binding)||!owner.revision)throw denied();
  return current;
 }
 #decode(issuer:SmtpIssuer,row:StoredSmtpConfiguration):CorporateSmtpConfiguration{
  if(row.companyId!==issuer.companyId||row.ruc!==issuer.ruc||!Number.isInteger(row.revision)||row.revision<1||row.revision>2147483647)throw unavailable();
  const bytes=this.#vault.open(row.configurationCipher,row.keyVersion,issuer);
  try{
   const config=JSON.parse(bytes.toString('utf8'));
   if(!config||Array.isArray(config)||Object.keys(config).sort().join(',')!=='fromAddress,fromName,host,password,port,replyTo,tlsMode,username')throw unavailable();
   return {...parseSmtpSettings({host:config.host,port:config.port,tlsMode:config.tlsMode,fromName:config.fromName,fromAddress:config.fromAddress,replyTo:config.replyTo}),
    ...parseSmtpCredentials({username:config.username,password:config.password})};
  }catch{throw unavailable();}finally{bytes.fill(0);}
 }
 #view(issuer:SmtpIssuer,row:StoredSmtpConfiguration|null){
  let config:CorporateSmtpConfiguration|undefined;
  let integrity:'NOT_CONFIGURED'|'VALID'|'INVALID'=row?'INVALID':'NOT_CONFIGURED';
  if(row)try{config=this.#decode(issuer,row);integrity='VALID';}catch{/* Prepared status reports integrity without secret material. */}
  const settings=config?{host:config.host,port:config.port,tlsMode:config.tlsMode,fromName:config.fromName,fromAddress:config.fromAddress,replyTo:config.replyTo}:null;
  return {...issuer,state:EXTERNAL_SMTP_STATE,revision:row?.revision??0,updatedAt:row?.updatedAt??null,configured:Boolean(row),credentialsConfigured:Boolean(config),settings,
   storageReady:true,encryption:this.#vault.readiness(),integrity,approvedHostListConfigured:true,hostnameApproved:Boolean(config&&approvedHost(config.host,[...this.#hosts])),
   networkAttempted:false,dnsValidated:false,smtpAuthenticationVerified:false,deliveredToClient:false,readyToSend:false};
 }
 #statusFor(caps:Phase8AdminContextResolver,companyId:string,handle:string|object){return this.#run(async()=>{
  const context=await this.#context(caps,companyId,handle,'SMTP_READ',{}),row=await this.#store.read(context.issuer);
  const result=this.#view(context.issuer,row),current=await this.#context(caps,companyId,handle,'SMTP_READ',{});
  if(adminDigest(current)!==adminDigest(context))throw denied();return result;
 });}
 #saveFor(caps:Phase8AdminContextResolver,companyId:string,body:unknown,handle:string|object){return this.#run(async()=>{
  const payload=adminSnapshot(body),context=await this.#context(caps,companyId,handle,'SMTP_SAVE',payload),input=parseSmtpInput(payload);
  if(!approvedHost(input.settings.host,[...this.#hosts]))throw new AccessError(400,'B2B_MAILER_SMTP_HOST_NOT_APPROVED');
  const before=await this.#store.read(context.issuer);
  if((before?.revision??0)!==input.expectedRevision)throw new AccessError(409,'B2B_MAILER_SMTP_REVISION_CONFLICT');
  const previous=input.credentials?undefined:before?this.#decode(context.issuer,before):undefined;
  const credentials=input.credentials??(previous?{username:previous.username,password:previous.password}:undefined);
  if(!credentials)throw new AccessError(400,'B2B_MAILER_SMTP_INITIAL_CREDENTIALS_REQUIRED');
  const plaintext=Buffer.from(JSON.stringify({...input.settings,...credentials}));
  let sealed:{cipher:string;keyVersion:number};
  try{sealed=this.#vault.seal(plaintext,context.issuer);}finally{plaintext.fill(0);}
  const revalidate=async()=>{const current=await this.#context(caps,companyId,handle,'SMTP_SAVE',payload);if(adminDigest(current)!==adminDigest(context))throw denied();};
  const row=await this.#store.save(context.issuer,sealed,input.expectedRevision,context.actorId,Boolean(input.credentials),revalidate);
  await revalidate();return this.#view(context.issuer,row);
 });}
 close(){if(this.#closing)return this.#closing;this.#closed=true;
  return this.#closing=(async()=>{try{await Promise.allSettled([...this.#active]);}finally{this.#vault.close();}})();
 }
 toJSON(){return {service:'MailerSmtpOwnerResource',environment:'BETA',profile:'PREPARED_ONLY',closed:this.#closed};}
 [inspect.custom](){return this.toJSON();}
}
/** Constructor is inert: copies mounted key/config only. checkStorage is SELECT-only.
 * Caller must erase its input key buffer and configure the shared pool with verified PG TLS. */
export function createMailerSmtpOwnerResource(options:MailerSmtpOwnerOptions):MailerSmtpOwnerResource{return new MailerHostSmtpResource(options);}
export {loadMailerSmtpOwnerMount,MailerSmtpOwnerMount} from './host-smtp.mount';
