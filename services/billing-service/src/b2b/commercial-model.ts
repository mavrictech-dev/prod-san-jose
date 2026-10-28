import type {B2bBinding,B2bPrincipal} from '@factuez/contracts/b2b-security';
import type {DraftBody,DraftIssueResult,DraftOperation} from './draft-model';
export type CommercialKind='SALES_NOTE'|'CORRECTION_REQUEST';
export type CommercialAction='CREATE'|'PATCH'|'COMPLETE'|'CONVERT'|'CANCEL';
export interface CorrectionBody {
  originalDocumentId:string;kind:'CREDIT_NOTE'|'DEBIT_NOTE'|'VOID';reason:string;
  proposedAmount?:string;externalReference:{namespace:string;value:string};
}
export interface OriginalReference {id:string;binding:B2bBinding;currency:'PEN'|'USD';payableAmount:string;snapshotSha256:string;fullNumber:string}
export interface CreditObservation {declaredAmount:string;snapshotAmount:string|null;currency:string;referenceDocumentId:string|null;referenceSha256:string|null}
export interface CommercialResource {
  id:string;kind:CommercialKind;clientId:string;actorKey:string;binding:B2bBinding;
  body:DraftBody|CorrectionBody;revision:number;
  state:'DRAFT'|'COMPLETED'|'CONVERTED'|'CANCELLED'|'BLOCKED_FISCAL_EXECUTION';
  commercialNumber:string|null;completedSha256:string|null;original:OriginalReference|null;
  convertedDocumentId:string|null;convertedDraftId:string|null;createdAt:string;updatedAt:string;
}
export interface CommercialOperation {
  id:string;requestId:string;clientId:string;actorKey:string;
  actor:Pick<B2bPrincipal,'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>;
  keyHash:string;requestHash:string;resourceId:string;kind:CommercialKind;action:CommercialAction;
  binding:B2bBinding;at:string;response:any;
}
export interface CommercialTransaction {
  get(id:string):Promise<CommercialResource|null>;
  list(clientId:string,actorKey:string,kind:CommercialKind,bindings:B2bBinding[],limit:number,after:string|null):Promise<CommercialResource[]>;
  create(resource:CommercialResource):Promise<void>;
  save(resource:CommercialResource,expected:number):Promise<void>;
  nextNumber(binding:B2bBinding):Promise<string>;
  prior(clientId:string,actorKey:string,keyHash:string):Promise<CommercialOperation|null>;
  operation(id:string,clientId:string,actorKey:string):Promise<CommercialOperation|null>;
  append(operation:CommercialOperation):Promise<void>;
  original(id:string):Promise<OriginalReference|null>;
  /** Bounded local declarations, including rejected/pending projections; NEVER accepted evidence. */
  observedCredits(originalId:string,issuerId:number):Promise<CreditObservation[]>;
  convert?(resource:CommercialResource,operation:DraftOperation):Promise<DraftIssueResult>;
}
export interface CommercialStore {transaction<T>(scope:string,work:(tx:CommercialTransaction)=>Promise<T>):Promise<T>}
