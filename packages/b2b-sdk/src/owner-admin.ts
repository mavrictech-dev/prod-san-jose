import {inspect} from 'node:util';
import {BoundedTransport,type FactuEzB2bOptions,type Operation} from './transport';
import * as v from './owner-admin-validation';
import type * as t from './owner-admin-types';
const operations = {
  MASTERS_READ:'ownerMasters',ISSUER_CREATE:'ownerIssuerCreate',ISSUER_UPDATE:'ownerIssuerUpdate',BRANCH_CREATE:'ownerBranchCreate',BRANCH_UPDATE:'ownerBranchUpdate',POINT_CREATE:'ownerPointCreate',POINT_UPDATE:'ownerPointUpdate',SERIES_CREATE:'ownerSeriesCreate',SERIES_UPDATE:'ownerSeriesUpdate',
  USERS_LIST:'ownerUsers',USERS_CREATE:'ownerUserCreate',USERS_UPDATE:'ownerUserUpdate',ROLES_LIST:'ownerRoles',ROLES_UPDATE:'ownerRoleUpdate',PRINT_READ:'ownerPrintRead',PRINT_SAVE:'ownerPrintSave',PRINT_PREVIEW:'ownerPrintPreview',FISCAL_READ:'ownerFiscalRead',FISCAL_AUDIT:'ownerFiscalAudit',FISCAL_SAVE:'ownerFiscalSave',SMTP_READ:'ownerSmtpRead',SMTP_SAVE:'ownerSmtpSave',
} as const satisfies Record<t.OwnerAdminAction,Operation>;
/** Delegated current USER bearer, re-obtained for every request. Never caches authority or retries writes. */
export class FactuEzB2bOwnerAdminClient {
  #transport:BoundedTransport;
  constructor(options:FactuEzB2bOptions){this.#transport=new BoundedTransport(options,false);}
  toJSON(){return {sdk:'FactuEzB2bOwnerAdminClient',environment:'BETA'};}
  [inspect.custom](){return 'FactuEzB2bOwnerAdminClient { environment: BETA, credentials: [PRIVATE] }';}
  async #call<T,A extends t.OwnerAdminAction>(action:A,binding:t.OwnerAdminBinding,body?:unknown,target?:unknown,page?:string):Promise<t.OwnerAdminResponse<T,A>>{
    const call=v.request(action,binding,body,target,page);
    const reply=await this.#transport.json(operations[action],call.ids,call.query,call.body);
    return v.response<T,A>(reply,action,call);
  }
  readMasters(binding:t.OwnerAdminBinding){return this.#call<t.OwnerAdminCatalog,'MASTERS_READ'>('MASTERS_READ',binding);}
  createIssuer(binding:t.OwnerAdminBinding,body:t.OwnerAdminIssuerCreate){return this.#call<t.OwnerAdminIssuer,'ISSUER_CREATE'>('ISSUER_CREATE',binding,body);}
  updateIssuer(binding:t.OwnerAdminBinding,body:t.OwnerAdminIssuerUpdate){return this.#call<t.OwnerAdminIssuer,'ISSUER_UPDATE'>('ISSUER_UPDATE',binding,body);}
  createBranch(binding:t.OwnerAdminBinding,body:t.OwnerAdminBranchCreate){return this.#call<t.OwnerAdminBranch,'BRANCH_CREATE'>('BRANCH_CREATE',binding,body);}
  updateBranch(binding:t.OwnerAdminBinding,body:t.OwnerAdminBranchUpdate){return this.#call<t.OwnerAdminBranch,'BRANCH_UPDATE'>('BRANCH_UPDATE',binding,body);}
  createPoint(binding:t.OwnerAdminBinding,body:t.OwnerAdminPointCreate){return this.#call<t.OwnerAdminCreatedPoint,'POINT_CREATE'>('POINT_CREATE',binding,body);}
  updatePoint(binding:t.OwnerAdminBinding,body:t.OwnerAdminPointUpdate){return this.#call<t.OwnerAdminPoint,'POINT_UPDATE'>('POINT_UPDATE',binding,body);}
  createSeries(binding:t.OwnerAdminBinding,body:t.OwnerAdminSeriesCreate){return this.#call<t.OwnerAdminSeries,'SERIES_CREATE'>('SERIES_CREATE',binding,body);}
  updateSeries(binding:t.OwnerAdminBinding,body:t.OwnerAdminSeriesUpdate){return this.#call<t.OwnerAdminSeries,'SERIES_UPDATE'>('SERIES_UPDATE',binding,body);}
  listUsers(binding:t.OwnerAdminBinding){return this.#call<(t.OwnerAdminUser & {editable:boolean})[],'USERS_LIST'>('USERS_LIST',binding);}
  createUser(binding:t.OwnerAdminBinding,body:t.OwnerAdminUserCreate){return this.#call<t.OwnerAdminUser,'USERS_CREATE'>('USERS_CREATE',binding,body);}
  updateUser(binding:t.OwnerAdminBinding,userId:string,body:t.OwnerAdminUserUpdate){return this.#call<t.OwnerAdminUser,'USERS_UPDATE'>('USERS_UPDATE',binding,body,userId);}
  listRoles(binding:t.OwnerAdminBinding){return this.#call<t.OwnerAdminRole[],'ROLES_LIST'>('ROLES_LIST',binding);}
  updateRole(binding:t.OwnerAdminBinding,role:Exclude<t.OwnerAdminRoleCode,'ADMIN'>,body:t.OwnerAdminRoleUpdate){return this.#call<t.OwnerAdminRoleUpdated,'ROLES_UPDATE'>('ROLES_UPDATE',binding,body,role);}
  readPrintProfile(binding:t.OwnerAdminBinding){return this.#call<t.OwnerAdminPrintProfile,'PRINT_READ'>('PRINT_READ',binding);}
  savePrintProfile(binding:t.OwnerAdminBinding,body:t.OwnerAdminPrintSave){return this.#call<t.OwnerAdminPrintProfile,'PRINT_SAVE'>('PRINT_SAVE',binding,body);}
  previewPrintProfile(binding:t.OwnerAdminBinding,body:t.OwnerAdminPrintPreview){return this.#call<t.OwnerAdminPreviewPdf,'PRINT_PREVIEW'>('PRINT_PREVIEW',binding,body);}
  readFiscalConfiguration(binding:t.OwnerAdminBinding){return this.#call<t.OwnerAdminFiscalStatus,'FISCAL_READ'>('FISCAL_READ',binding);}
  readFiscalAudit(binding:t.OwnerAdminBinding,page='1'){return this.#call<t.OwnerAdminFiscalAudit,'FISCAL_AUDIT'>('FISCAL_AUDIT',binding,undefined,undefined,page);}
  saveFiscalConfiguration(binding:t.OwnerAdminBinding,body:t.OwnerAdminFiscalSave){return this.#call<t.OwnerAdminFiscalStatus,'FISCAL_SAVE'>('FISCAL_SAVE',binding,body);}
  readSmtpConfiguration(binding:t.OwnerAdminBinding){return this.#call<t.OwnerAdminSmtpStatus,'SMTP_READ'>('SMTP_READ',binding);}
  saveSmtpConfiguration(binding:t.OwnerAdminBinding,body:t.OwnerAdminSmtpSave){return this.#call<t.OwnerAdminSmtpStatus,'SMTP_SAVE'>('SMTP_SAVE',binding,body);}
}
