/** Local owner contracts: no service imports, credentials only in write inputs. */
import type {BusinessBinding} from './phase8-types';
export type OwnerAdminBinding = BusinessBinding;
export type OwnerAdminRoleCode = 'ADMIN'|'STATION_MANAGER'|'CASHIER'|'TRACK_OPERATOR'|'AUDITOR';
export type OwnerAdminPermission = 'setup.manage'|'user.manage'|'role.manage'|'product.manage'|'series.manage'|'sunat.configure'|'document.issue'|'document.view'|'document.retry'|'document.email'|'shift.open'|'shift.close'|'report.view'|'report.export'|'audit.view';
export type OwnerAdminSeriesType = 'INVOICE'|'SALES_RECEIPT'|'CREDIT_NOTE'|'DEBIT_NOTE'|'DESPATCH_ADVICE';
export type OwnerAdminAction = 'MASTERS_READ'|'ISSUER_CREATE'|'ISSUER_UPDATE'|'BRANCH_CREATE'|'BRANCH_UPDATE'|'POINT_CREATE'|'POINT_UPDATE'|'SERIES_CREATE'|'SERIES_UPDATE'|'USERS_LIST'|'USERS_CREATE'|'USERS_UPDATE'|'ROLES_LIST'|'ROLES_UPDATE'|'PRINT_READ'|'PRINT_SAVE'|'PRINT_PREVIEW'|'FISCAL_READ'|'FISCAL_AUDIT'|'FISCAL_SAVE'|'SMTP_READ'|'SMTP_SAVE';
export interface OwnerAdminResponse<T,A extends OwnerAdminAction=OwnerAdminAction> {
  schemaVersion:'factuez.b2b.owner-admin.v1'; action:A; binding:OwnerAdminBinding;
  environment:'BETA'; candidateOnly:true; fiscalExecutionEnabled:false; data:T;
}
export interface OwnerAdminRevision {expectedRevision:number}
export interface OwnerAdminIssuerCreate {ruc:string;legalName:string;taxAddress:string;ubigeo:string;tradeName?:string|null;phone?:string|null;contactEmails?:string[]}
export type OwnerAdminIssuerUpdate = OwnerAdminRevision & Partial<Omit<OwnerAdminIssuerCreate,'ruc'>> & {active?:boolean};
export interface OwnerAdminBranchCreate {companyId:number;code:string;name:string;address?:string|null}
export type OwnerAdminBranchUpdate = OwnerAdminRevision & Partial<Omit<OwnerAdminBranchCreate,'companyId'>> & {active?:boolean};
export interface OwnerAdminPointCreate {code:string;name:string;invoiceSeries:string;receiptSeries:string;address?:string|null;trackNumber?:number|null}
export type OwnerAdminPointUpdate = OwnerAdminRevision & Partial<Omit<OwnerAdminPointCreate,'invoiceSeries'|'receiptSeries'>> & {active?:boolean};
export interface OwnerAdminSeriesCreate {documentType:OwnerAdminSeriesType;series:string}
export interface OwnerAdminSeriesUpdate extends OwnerAdminRevision {active:boolean}
export interface OwnerAdminIssuer extends Required<OwnerAdminIssuerCreate> {id:number;environment:'BETA';active:boolean;revision:number}
export interface OwnerAdminBranch {id:string;companyId:number;code:string;name:string;address?:string|null;active:boolean;revision:number}
export interface OwnerAdminPoint extends OwnerAdminBranch {branchId:string;trackNumber?:number|null}
export interface OwnerAdminSeries extends OwnerAdminSeriesCreate {id:string;companyId:number;emissionPointId:string;nextNumber:string;active:boolean;revision:number}
export interface OwnerAdminCreatedPoint {id:string;companyId:number;branchId:string;code:string;name:string;active:boolean;revision:number;series:{id:string;documentType:OwnerAdminSeriesType;series:string;revision:number}[]}
export interface OwnerAdminCatalog {
  version:'factuez.station-admin.v1';capabilities:{betaOnly:true;softDelete:true;counterEditing:false};
  companies:OwnerAdminIssuer[];branches:(OwnerAdminBranch & {effectiveActive:boolean;pointCount:number;openShiftCount:number})[];
  emissionPoints:(OwnerAdminPoint & {effectiveActive:boolean;openShiftCount:number})[];
  series:(OwnerAdminSeries & {effectiveActive:boolean;documentCount:number;canRename:boolean})[];
}
export interface OwnerAdminUserCreate {username:string;fullName:string;password:string;roles:OwnerAdminRoleCode[];branchIds:string[];emissionPointIds:string[];series:string[]}
export type OwnerAdminUserUpdate = Partial<Pick<OwnerAdminUserCreate,'roles'|'branchIds'|'emissionPointIds'|'series'>> & {active?:boolean};
export interface OwnerAdminUser {id:string;username:string;fullName:string;active:boolean;lastLoginAt:string|null;roles:{code:OwnerAdminRoleCode;name:string}[];branchIds:string[];emissionPointIds:string[];series:string[]}
export interface OwnerAdminRole {id:string;code:OwnerAdminRoleCode;name:string;description:string|null;permissions:OwnerAdminPermission[];editable:boolean;assignable:boolean}
export interface OwnerAdminRoleUpdate {permissions:OwnerAdminPermission[];expectedPermissions:OwnerAdminPermission[]}
export interface OwnerAdminRoleUpdated {code:OwnerAdminRoleCode;permissions:OwnerAdminPermission[];affectedUsers:number}
export interface OwnerAdminPrintSettings {template:'SAN_JOSE_V1';logoMode:'DEFAULT'|'CUSTOM'|'NONE';logoWidthMm:number;logoAlignment:'LEFT'|'CENTER';showBranchAddress:boolean;footerNote:string}
export interface OwnerAdminLogoUpload {mediaType:'image/png'|'image/jpeg'|'image/webp';base64:string}
export interface OwnerAdminPrintDraft {settings:OwnerAdminPrintSettings|null;logoUpload?:OwnerAdminLogoUpload}
export interface OwnerAdminPrintSave extends OwnerAdminPrintDraft,OwnerAdminRevision {}
export interface OwnerAdminPrintPreview {documentTypeCode:'01'|'03'|'07'|'08'|'09'|'31';format:'a4'|'ticket';draft?:OwnerAdminPrintDraft}
export interface OwnerAdminPrintProfile {version:'factuez.print-settings.v1';companyId:number;ruc:string;branchId:string|null;revision:number;updatedAt:string|null;source:'BRANCH'|'ISSUER'|'DEFAULT';storageReady:boolean;fiscalTransmission:false;override:OwnerAdminPrintSettings|null;effective:OwnerAdminPrintSettings;logoConfigured:boolean}
/** Validated PDF decoded from the wire; no server path or URL is accepted. */
export interface OwnerAdminPreviewPdf {bytes:Buffer;contentType:'application/pdf';fileName:string}
export interface OwnerAdminFiscalSave extends OwnerAdminRevision {certificate?:{fileName:string;base64:string;password:string};sol?:{username:string;password:string};gre?:{clientId:string;clientSecret:string}}
export interface OwnerAdminFiscalStatus {ruc:string;environment:'BETA';revision:number;updatedAt:string|null;solConfigured:boolean;greConfigured:boolean;fiscalTransmission:false;certificate:{configured:boolean;fingerprint:string|null;expiresAt:string|null;selfSigned:boolean|null;expired:boolean;trustAndRucVerified:false}}
export interface OwnerAdminFiscalAudit {ruc:string;environment:'BETA';page:number;pageSize:10;total:number;items:{id:string;actorId:string;fields:('certificate'|'sol'|'gre'|'certificate.remove'|'sol.remove'|'gre.remove')[];revision:number;occurredAt:string}[]}
export interface OwnerAdminSmtpSave extends OwnerAdminRevision {settings:{host:string;port:465|587;tlsMode:'TLS'|'STARTTLS';fromName:string;fromAddress:string;replyTo?:string|null};credentials?:{username:string;password:string}}
export interface OwnerAdminSmtpStatus {companyId:number;ruc:string;state:'EXTERNAL_SMTP_DISABLED';revision:number;updatedAt:string|null;configured:boolean;credentialsConfigured:boolean;storageReady:boolean;encryption:'READY'|'MISSING'|'INVALID';integrity:'NOT_CONFIGURED'|'NOT_CHECKED'|'VALID'|'INVALID';approvedHostListConfigured:boolean;hostnameApproved:boolean;networkAttempted:false;dnsValidated:false;smtpAuthenticationVerified:false;deliveredToClient:false;readyToSend:false}

