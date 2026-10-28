import {AccessError} from '@factuez/service-access';
import {inspect} from 'node:util';
import type {CorporateEmailDependencies} from './email-deliveries.corporate';
import type {MailerHostSmtpStore} from './host-smtp.store';
import type {MailerHostSmtpVault} from './host-smtp.crypto';
import type {SmtpIssuer} from '../smtp-configuration.store';

const unavailable=()=>new AccessError(503,'EMAIL_SMTP_CONFIGURATION_UNAVAILABLE');
const validIssuer=(issuer:SmtpIssuer)=>Boolean(issuer && Number.isSafeInteger(issuer.companyId) && issuer.companyId>0 && issuer.companyId<=2147483647 && typeof issuer.ruc==='string' && /^\d{11}$/.test(issuer.ruc));
const versionOf=(cipher:unknown):number=>{
 if(typeof cipher!=='string'||cipher.length>5700)throw unavailable();
 const parts=cipher.split('.');
 if(parts.length!==5||parts[0]!=='v1'||!/^[1-9]\d{0,4}$/.test(parts[1])||Number(parts[1])>10000||parts.slice(2).some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw unavailable();
 return Number(parts[1]);
};
/** Private composition ports only. Does not construct, activate or close either dependency. */
export function createCorporateHostSmtpReadAdapter(store:Pick<MailerHostSmtpStore,'read'>,vault:Pick<MailerHostSmtpVault,'open'>):Pick<CorporateEmailDependencies,'configurations'|'vault'> {
 if(!store||typeof store.read!=='function'||!vault||typeof vault.open!=='function')throw unavailable();
 const configurations:CorporateEmailDependencies['configurations']={
  async read(input){
   try{
    if(!validIssuer(input))throw unavailable();
    const issuer={companyId:input.companyId,ruc:input.ruc};
    const row=await store.read({...issuer});
    if(row===null)return null;
    if(!row||row.companyId!==issuer.companyId||row.ruc!==issuer.ruc||!Number.isSafeInteger(row.revision)||row.revision<1||row.revision>2147483647||
      !Number.isSafeInteger(row.keyVersion)||row.keyVersion!==versionOf(row.configurationCipher)||!(row.updatedAt instanceof Date)||!Number.isFinite(row.updatedAt.getTime()))throw unavailable();
    return {companyId:issuer.companyId,ruc:issuer.ruc,configurationCipher:row.configurationCipher,keyVersion:row.keyVersion,revision:row.revision,updatedAt:new Date(row.updatedAt.getTime())};
   }catch{throw unavailable();}
  }
 };
 const corporateVault:CorporateEmailDependencies['vault']={
  open(cipher,context){
   try{
    if(!validIssuer(context)||context.field!=='configuration')throw unavailable();
    const version=versionOf(cipher);
    return vault.open(cipher,version,{companyId:context.companyId,ruc:context.ruc});
   }catch{throw unavailable();}
  }
 };
 // The ports carry ciphertext and plaintext only through method results, never through inspection.
 Object.defineProperty(configurations,inspect.custom,{value:()=> 'CorporateHostSmtpConfigurations { PRIVATE }'});
 Object.defineProperty(corporateVault,inspect.custom,{value:()=> 'CorporateHostSmtpVault { PRIVATE }'});
 return Object.freeze({configurations:Object.freeze(configurations),vault:Object.freeze(corporateVault)});
}