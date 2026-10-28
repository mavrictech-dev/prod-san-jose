import type { B2bBinding, B2bCorrectionBinding, B2bPrincipal } from '@factuez/contracts/b2b-security';
import type { B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import type { ReportRow, ReportsAuth, ReportsCapture, ReportsFilters } from './types';
export type ReportsActor=Pick<B2bPrincipal,'kind'|'clientId'|'subjectId'|'revision'|'userAuthRevision'>;
export type ReportsAccess =
  | {kind:'CORRECTION';binding:B2bCorrectionBinding;grantRevision:number}
  | {kind:'GUIDE';binding:B2bGuideIssueBinding;grantRevision:number}
  | {kind:'SALES_NOTE';binding:B2bBinding;grantRevision:null};
export const reportActor=(p:B2bPrincipal):ReportsActor=>({kind:p.kind,clientId:p.clientId,subjectId:p.subjectId,revision:p.revision,userAuthRevision:p.userAuthRevision});
/** New LOCAL read port. Must be implemented by an authenticated authority.
 * A report grant cannot be inferred from the reference binding or a write proof. */
export interface ReportsCorrectionReadAuthority {
  current(token:string,kind:ReportsAuth['kind'],binding:B2bCorrectionBinding):Promise<{
    action:'READ';binding:B2bCorrectionBinding;actor:ReportsActor;clientRevision:number;grantRevision:number;
  }>;
}
/** Compatible with the existing guide owner READ authority, including mTLS adapters. */
export interface ReportsGuideReadAuthority {
  current(token:string,kind:ReportsAuth['kind'],binding:B2bGuideIssueBinding,action:'READ'):Promise<{
    binding:B2bGuideIssueBinding;clientRevision:number;grantRevision:number;actor:{b2b?:ReportsActor};
  }>;
}
export interface ReportsSupplementalSources {
  capture(auth:ReportsAuth,p:B2bPrincipal,filters:ReportsFilters):Promise<{rows:ReportRow[];access:ReportsAccess[];capturedAt:string}>;
  authorize(auth:ReportsAuth,p:B2bPrincipal,capture:ReportsCapture):Promise<void>;
}
export interface ReportsSourceRecord {access:ReportsAccess;value:any}
/** Owner-local only. This pool must belong to billing; never connect another owner's database. */
export interface ReportsOwnerSourceStore {
  capture(p:B2bPrincipal,filters:ReportsFilters,access:ReportsAccess[]):Promise<{records:ReportsSourceRecord[];capturedAt:string}>;
}

