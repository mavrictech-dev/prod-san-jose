import type { B2bBinding,B2bPrincipal } from '@factuez/contracts/b2b-security';
export type DraftAction='CREATE'|'PATCH'|'VALIDATE'|'CANCEL'|'ISSUE';
export interface DraftBody {
  issuerId:number;branchId:string;pointId:string;seriesId:string;environment:'BETA';documentType:'01'|'03';currency:'PEN'|'USD';paymentTerms:'CONTADO';
  externalReference:{namespace:string;value:string};issueDate:string;
  customer:{identityType:'0'|'1'|'6';identityNumber:string;legalName:string;address?:string;email?:string};
  lines:{productId?:string;productCode?:string;description:string;unitCode:string;quantity:string;unitPriceWithTax:string;taxAffectationCode:'10';igvRate:'18'}[];
}
export interface Draft {id:string;clientId:string;actorKey:string;binding:B2bBinding;body:DraftBody;revision:number;state:'DRAFT'|'CANCELLED'|'ISSUED';validatedRevision:number|null;createdAt:string;updatedAt:string}
export interface DraftOperation {id:string;commandId:string;requestId:string;clientId:string;actorKey:string;actor:Pick<B2bPrincipal,'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>;keyHash:string;requestHash:string;action:DraftAction;draftId:string;binding:B2bBinding;at:string;response:unknown;documentId?:string}
export interface DraftIssueResult {documentId:string;series:string;number:string;fullNumber:string}
export interface DraftTransaction {
  get(id:string):Promise<Draft|null>;create(draft:Draft):Promise<void>;save(draft:Draft,expected:number):Promise<void>;
  prior(clientId:string,actorKey:string,keyHash:string):Promise<DraftOperation|null>;
  operation(id:string,clientId:string,actorKey:string):Promise<DraftOperation|null>;
  append(operation:DraftOperation):Promise<void>;
  /** Present only when the owner explicitly binds an issuer to THIS transaction. */
  issue?(draft:Draft,operation:DraftOperation):Promise<DraftIssueResult>;
}
export interface DraftStore {transaction<T>(scope:string,work:(tx:DraftTransaction)=>Promise<T>):Promise<T>}
