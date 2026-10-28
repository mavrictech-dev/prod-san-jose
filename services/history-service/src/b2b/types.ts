import type { B2bBinding,B2bPrincipal,B2bIdentityScope } from '@factuez/contracts/b2b-security';
import type { HISTORY_ARTIFACT_KINDS } from '@factuez/history-core';
import type { HistoryActor } from '../access';
export type B2bHistoryAuth={token:string;kind:'SERVICE'|'USER'};
export type B2bHistoryAction='LIST'|'DETAIL'|'CONTENT';
export type B2bHistoryArtifactKind=typeof HISTORY_ARTIFACT_KINDS[number];
export interface B2bHistoryInputMap {
  LIST:{binding:B2bBinding;take?:number;afterRecordId?:string};
  DETAIL:{binding:B2bBinding;recordId:string};
  CONTENT:{binding:B2bBinding;recordId:string;artifactKind:B2bHistoryArtifactKind};
}
/** Live B2B Identity authority, never the legacy HistoryReadIdentityAdapter. */
export interface B2bHistoryLiveIdentity {
  authenticate(token:string,scopes:B2bIdentityScope[],kind:'SERVICE'|'USER'):Promise<B2bPrincipal>;
}
export interface B2bHistoryArchiveDecision {
  environment:'BETA';datasetClass:'SYNTHETIC';permission:'history.view';
  enrollmentId:string;revision:string;binding:B2bBinding;
  /** Independently enrolled archive actor; no synthesized user from a service client. */
  actor:HistoryActor;
}
/** A separately enrolled archive permission is required on EVERY authorization. No automatic mapping. */
export interface B2bHistoryArchivePermissionPort {
  authorizeCurrent(input:{principal:B2bPrincipal;binding:B2bBinding}):Promise<B2bHistoryArchiveDecision|null>;
}
export interface B2bHistoryArchivePort {
  execute<A extends B2bHistoryAction>(action:A,input:B2bHistoryInputMap[A],livePrincipal:()=>Promise<B2bPrincipal>):Promise<unknown>;
}