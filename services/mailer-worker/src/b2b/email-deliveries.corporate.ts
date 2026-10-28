import {createRequire} from 'node:module';
import {lookup} from 'node:dns/promises';
import {inspect} from 'node:util';
import type {SendMailOptions} from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type {SmtpConfigurationStore} from '../smtp-configuration.store';
import type {SmtpConfigurationVault} from '../smtp-configuration.crypto';
import {approvedHost, smtpHostname, parseSmtpCredentials, parseSmtpSettings,
  type CorporateSmtpConfiguration} from '../smtp-configuration.policy';
import {B2bEmailDeliveries, checkedEmailDocument, emailSameActor, emailSameCorporateAuthorization, emailFail, emailHash, emailUuid} from './email-deliveries';
import {b2bBindingsContain, validB2bPrincipal, type B2bIdentityScope} from './email-deliveries.security';
import {OwnerEmailDeliveryDocumentSource, type EmailDeliveryArtifactOwner} from './email-deliveries.source';
import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import type {B2bPrincipal, EmailDeliveryCorporateAuthorization, EmailDeliveryCorporateRequest,
  EmailDeliveryCorporateTransport, EmailDeliveryDocument, EmailDeliveryExecutionAuthority,
  EmailDeliveryJob, EmailDeliveryProfile, EmailDeliveryStore} from './email-deliveries.types';

/** Trusted owner capability, NEVER an HTTP body or an inference from mail-config:manage.
 * The owner checks live application/user, RUC, branch, document/recipient and artifact proof.
 * Revocation or any material grant change MUST change the revision or return null. */
export interface CorporateEmailSendPermission {
  authorizeRealSendCurrent(principal: B2bPrincipal, request: EmailDeliveryCorporateRequest,
    document: EmailDeliveryDocument): Promise<{allowed: true; grantId: string; grantRevision: number}|null>;
}
export interface CorporateEmailDependencies {
  permission: CorporateEmailSendPermission;
  configurations: Pick<SmtpConfigurationStore,'read'>;
  vault: Pick<SmtpConfigurationVault,'open'>;
}
export interface CorporateEmailOptions {
  enabled?: boolean;
  realSendEnabled?: boolean;
  /** Explicit infrastructure allowlist; no process.env, implicit host, credentials or network fallback. */
  approvedHosts?: readonly string[];
  /** TI-only exact RFC1918 relay pins. No CIDRs, wildcards, loopback or metadata addresses. */
  privateRelays?: readonly {host:string;address:string}[];
  tlsCa?: Buffer;
}
export interface CorporateEmailMailer {
  sendMail(message: SendMailOptions): Promise<{
    messageId: string; accepted: unknown[]; rejected: unknown[]; pending?: unknown[]; response: string;
  }>;
  close(): void;
}
export interface CorporateEmailNetwork {
  resolve(host: string): Promise<readonly string[]>;
  createTransport(options: SMTPTransport.Options): CorporateEmailMailer;
}
const actualNetwork: CorporateEmailNetwork = {
  resolve: async host => (await lookup(host,{family:4,all:true})).map(a=>a.address),
  createTransport: options => createRequire(__filename)('nodemailer').createTransport(options),
};
const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0&&Number(n)<=2147483647;
/** IPv4-only SMTP pinning. Reject mixed/private answers; never let Nodemailer re-resolve the hostname. */
function publicIpv4(address: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return false;
  const octets=address.split('.').map(Number),[a,b,c]=octets;
  return octets.every((n,i)=>n<=255&&String(n)===address.split('.')[i]) && a>0 && a<224 &&
    ![10,127].includes(a) && !(a===100&&b>=64&&b<=127) && !(a===169&&b===254) &&
    !(a===172&&b>=16&&b<=31) && !(a===192&&(b===168||b===0||b===2)) &&
    !(a===198&&(b===18||b===19||b===51&&c===100)) && !(a===203&&b===0&&c===113);
}
function privateIpv4(address:string){
 if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))return false;
 const octets=address.split('.').map(Number),[a,b]=octets;
 if(octets.some((n,i)=>n>255||String(n)!==address.split('.')[i])||!(a===10||a===172&&b>=16&&b<=31||a===192&&b===168))return false;
 return true;
}
function allowedRelay(host:string,address:string,pins:readonly {host:string;address:string}[]){
 return publicIpv4(address)||privateIpv4(address)&&pins.some(p=>p.host===host&&p.address===address);
}
/** Same mandatory policy as smtp-configuration.policy, with an explicit allowlist instead of env defaults.
 * PreparedCorporateSmtp and its disabled verify/send paths are deliberately not changed. */
export function corporateEmailSmtpOptions(configuration: CorporateSmtpConfiguration,
  hosts: readonly string[], address: string,privateRelays:readonly {host:string;address:string}[]=[],tlsCa?:Buffer): SMTPTransport.Options {
  try {
    const settings=parseSmtpSettings({host:configuration.host,port:configuration.port,tlsMode:configuration.tlsMode,
      fromName:configuration.fromName,fromAddress:configuration.fromAddress,replyTo:configuration.replyTo});
    const credentials=parseSmtpCredentials({username:configuration.username,password:configuration.password});
    if (!hosts.length||hosts.length>16||hosts.some(h=>!smtpHostname(h))||
      !approvedHost(settings.host,[...hosts])||privateRelays.length>16||privateRelays.some(p=>!p||!smtpHostname(p.host)||!hosts.includes(p.host)||!privateIpv4(p.address))||
      !allowedRelay(settings.host,address,privateRelays)||tlsCa!==undefined&&(!Buffer.isBuffer(tlsCa)||!tlsCa.length||tlsCa.length>262144)) emailFail(503,'EMAIL_SMTP_POLICY');
    return {host:address,port:settings.port,secure:settings.port===465,requireTLS:true,ignoreTLS:false,
      opportunisticTLS:false,pool:false,auth:{type:'login',user:credentials.username,pass:credentials.password},
      tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:settings.host,...(tlsCa?{ca:Buffer.from(tlsCa)}:{})},
      connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,dnsTimeout:5000,
      disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false};
  } catch { return emailFail(503,'EMAIL_SMTP_POLICY'); }
}

/** No I/O in import/constructor. Configuration reads/decryption happen only through supplied owner ports.
 * No write/configuration management method is available to a sender. No verify(), pooling or retry. */
export class NodemailerCorporateEmailTransport implements EmailDeliveryCorporateTransport {
  readonly profile='CORPORATE' as const;
  private readonly options: Readonly<CorporateEmailOptions>;
  constructor(private readonly owner: CorporateEmailDependencies, options: CorporateEmailOptions={},
    private readonly network: CorporateEmailNetwork=actualNetwork) {
    this.options=Object.freeze({...options,approvedHosts:Object.freeze([...(options.approvedHosts??[])]),privateRelays:Object.freeze((options.privateRelays??[]).map(p=>Object.freeze({...p}))),...(options.tlsCa?{tlsCa:Buffer.from(options.tlsCa)}:{})});
  }
  private open() {
    if (this.options.enabled!==true||this.options.realSendEnabled!==true) emailFail(503,'EMAIL_CORPORATE_DISABLED');
    if (!this.options.approvedHosts?.length) emailFail(503,'EMAIL_SMTP_POLICY');
  }
  private async permission(p:B2bPrincipal,r:EmailDeliveryCorporateRequest,d:EmailDeliveryDocument) {
    const scopes: B2bIdentityScope[]=['b2b:email:send','b2b:documents:read','b2b:artifacts:read'];
    if (!validB2bPrincipal(p)||!scopes.every(s=>p.scopes.includes(s))||
      !b2bBindingsContain(p.bindings,r.binding)) emailFail(403,'EMAIL_REAL_SEND_FORBIDDEN');
    const request={binding:structuredClone(r.binding),documentId:r.documentId,recipient:r.recipient,format:r.format};
    const grant=await this.owner.permission.authorizeRealSendCurrent(structuredClone(p),request,checkedEmailDocument(d,r));
    if (!grant?.allowed||!emailUuid(grant.grantId)||!positive(grant.grantRevision)) emailFail(403,'EMAIL_REAL_SEND_FORBIDDEN');
    return {grantId:grant!.grantId,grantRevision:grant!.grantRevision};
  }
  private async resolve(p:B2bPrincipal,r:EmailDeliveryCorporateRequest,d:EmailDeliveryDocument) {
    this.open();
    const grant=await this.permission(p,r,d);
    const issuer={companyId:r.binding.issuerId,ruc:r.binding.issuerRuc};
    let configuration:CorporateSmtpConfiguration;
    let revision:number,snapshotId:string;
    try {
      const row=await this.owner.configurations.read(issuer);
      if (!row||row.companyId!==issuer.companyId||row.ruc!==issuer.ruc||!positive(row.revision)||!positive(row.keyVersion)||
        typeof row.configurationCipher!=='string'||row.configurationCipher.length>5700||
        row.configurationCipher.split('.')[1]!==String(row.keyVersion)) emailFail(503,'EMAIL_SMTP_CONFIGURATION_UNAVAILABLE');
      const plaintext=this.owner.vault.open(row!.configurationCipher,{...issuer,field:'configuration'});
      try {
        const raw=JSON.parse(plaintext.toString('utf8'));
        if (!raw||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='fromAddress,fromName,host,password,port,replyTo,tlsMode,username')
          emailFail(503,'EMAIL_SMTP_CONFIGURATION_UNAVAILABLE');
        configuration={...parseSmtpSettings({host:raw.host,port:raw.port,tlsMode:raw.tlsMode,fromName:raw.fromName,
          fromAddress:raw.fromAddress,replyTo:raw.replyTo}),...parseSmtpCredentials({username:raw.username,password:raw.password})};
      } finally { plaintext.fill(0); }
      revision=row!.revision;snapshotId=emailHash(row!.configurationCipher);
    } catch { return emailFail(503,'EMAIL_SMTP_CONFIGURATION_UNAVAILABLE'); }
    if (!approvedHost(configuration.host,[...this.options.approvedHosts!])) emailFail(503,'EMAIL_SMTP_POLICY');
    const latestGrant=await this.permission(p,r,d);
    if (JSON.stringify(grant)!==JSON.stringify(latestGrant)) emailFail(403,'EMAIL_REAL_SEND_FORBIDDEN');
    return {configuration,authorization:{...grant,configurationRevision:revision,configurationSnapshotId:snapshotId}};
  }
  async authorizeCurrent(p:B2bPrincipal,r:EmailDeliveryCorporateRequest,d:EmailDeliveryDocument):Promise<EmailDeliveryCorporateAuthorization> {
    return (await this.resolve(p,r,d)).authorization;
  }
  async send(job:Readonly<EmailDeliveryJob>,document:EmailDeliveryDocument,current:()=>Promise<B2bPrincipal>):Promise<{state:'SMTP_ACCEPTED'}> {
    this.open();
    const j=structuredClone(job),d=checkedEmailDocument(document,j);
    if (j.profile!=='CORPORATE'||j.state!=='DISPATCHING'||!emailUuid(j.id)||!emailUuid(j.attemptId)||
      !j.corporate||j.corporate.messageId!=='<factuez-b2b-'+j.id+'@delivery.factuez.invalid>'||d.attachments.length!==3)
      emailFail(503,'EMAIL_CORPORATE_DISABLED');
    const {messageId,...expected}=j.corporate!;
    const resolve=async()=>{
      const p=await current();
      if (!emailSameActor(p,j.actor)) emailFail(401,'ACCESS_CHANGED');
      const resolved=await this.resolve(p,j,d);
      if (!emailSameCorporateAuthorization(resolved.authorization,expected)) emailFail(409,'EMAIL_SMTP_CONFIGURATION_CHANGED');
      return resolved.configuration;
    };
    const configuration=await resolve();
    const addresses=await this.network.resolve(configuration.host);
    if (!addresses.length||addresses.length>32||addresses.some(a=>!allowedRelay(configuration.host,a,this.options.privateRelays??[]))) emailFail(503,'EMAIL_SMTP_POLICY');
    // DNS is pinned before a second live grant/configuration check; no factory is called on a stale snapshot.
    const latest=await resolve();
    if (JSON.stringify(configuration)!==JSON.stringify(latest)) emailFail(409,'EMAIL_SMTP_CONFIGURATION_CHANGED');
    const options=corporateEmailSmtpOptions(latest,this.options.approvedHosts!,addresses[0],this.options.privateRelays,this.options.tlsCa);
    const mailer=this.network.createTransport(options);
    try {
      const final=await resolve();
      if (JSON.stringify(latest)!==JSON.stringify(final)) emailFail(409,'EMAIL_SMTP_CONFIGURATION_CHANGED');
      await current();
      const result=await mailer.sendMail({from:{name:final.fromName,address:final.fromAddress},to:j.recipient,
        ...(final.replyTo?{replyTo:final.replyTo}:{}),messageId,
        envelope:{from:final.fromAddress,to:[j.recipient]},subject:'Representación de documento',
        text:'Se adjuntan la representación PDF vigente y los originales XML y CDR del documento.',
        headers:{'X-FactuEz-Delivery-Id':j.id,'X-FactuEz-Profile':'CORPORATE','X-FactuEz-Environment':'BETA'},
        disableFileAccess:true,disableUrlAccess:true,
        attachments:d.attachments.map(a=>({filename:a.fileName,content:Buffer.from(a.bytes),contentType:a.mediaType,
          contentDisposition:'attachment',headers:{'X-Content-Sha256':a.sha256}}))});
      if (result?.messageId!==messageId||result.accepted?.length!==1||result.accepted[0]!==j.recipient||
        !Array.isArray(result.rejected)||result.rejected.length||result.pending?.length||!/^250(?:[ -]|$)/.test(result.response))
        emailFail(503,'EMAIL_OWNER_UNAVAILABLE');
      return {state:'SMTP_ACCEPTED'};
    } finally { try {mailer.close();} catch { /* Closing must not erase the known SMTP result. */ } }
  }
  toJSON(){return {transport:'NodemailerCorporateEmailTransport',credentials:'PRIVATE'};}
  [inspect.custom](){return 'NodemailerCorporateEmailTransport { credentials: [PRIVATE] }';}
}

/** Explicit assembly, with no main-module registration, environment discovery, implicit DB or SMTP.
 * Supply a CORPORATE-capable durable store (the separate candidate schema), current owner permission,
 * read-only SMTP store/vault, artifact owner and live execution identity. Default profile remains NONE. */
export function createCorporateEmailDeliveries(input:{store:EmailDeliveryStore;identity:B2bIdentityPort;
  artifacts:EmailDeliveryArtifactOwner;execution:EmailDeliveryExecutionAuthority;owner:CorporateEmailDependencies;
  options?:CorporateEmailOptions & {profile?:EmailDeliveryProfile};network?:CorporateEmailNetwork}) {
  const options=input.options??{},profile=options.profile??'NONE';
  if (profile!=='NONE'&&profile!=='CORPORATE') emailFail(400,'INVALID_REQUEST');
  const transport=profile==='CORPORATE'?new NodemailerCorporateEmailTransport(input.owner,options,input.network):null;
  const engine=new B2bEmailDeliveries(input.store,input.identity,new OwnerEmailDeliveryDocumentSource(input.artifacts),transport,
    {enabled:options.enabled,profile});
  return {engine,run:(jobId:string)=>engine.run(jobId,input.execution)};
}
