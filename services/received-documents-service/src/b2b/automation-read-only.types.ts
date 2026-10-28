import type {ReceivedAutomationSettings} from '@factuez/contracts';
import type {ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import type {ReceptionDispatchContext} from './automation-dispatch';
import type {SirePurchase} from '../automation/sire-client';

export type ReadOnlyReceptionAdmission={approvalId:string;revision:number;profile:'READ_ONLY';contextSha256:string;
 configurationSha256:string;approvedImapHosts:readonly string[]};
export interface ReadOnlyReceptionAdmissionPort{
 authorize(context:ReceptionDispatchContext,configurationSha256:string):Promise<ReadOnlyReceptionAdmission>;
}
export type ReadOnlyReceptionCursor={fingerprint:string;uidValidity:string;lastUid:string};
export type ReadOnlyReceptionSnapshot={context:ReceptionDispatchContext;configurationSha256:string;
 settings:ReceivedAutomationSettings;encryptedCredentials:string|null;periods:readonly string[];
 admission:ReadOnlyReceptionAdmission;cursor:ReadOnlyReceptionCursor|null};
export type ReadOnlyReceptionFile={fileName:string;contentBase64:string};
export type ReadOnlyReceptionDocument={file:ReadOnlyReceptionFile;artifacts:{kind:'CDR'|'PROVIDER_PDF';file:ReadOnlyReceptionFile}[]};
export type ReadOnlyReceptionIncident={code:'INVALID_MESSAGE'|'INVALID_DOCUMENT'|'DOCUMENT_TOO_LARGE'|'ARTIFACT_UNMATCHED'|'SIRE_RECORD_REJECTED';sourceSha256:string};
export type ReadOnlyReceptionBatch={documents:ReadOnlyReceptionDocument[];purchases:SirePurchase[];
 incidents:ReadOnlyReceptionIncident[];cursor:ReadOnlyReceptionCursor|null};
export interface ReadOnlyReceptionSource{
 /** Network reads only, outside the commit transaction. The supplied check
  * must run before/after each remote request and before consuming a message.
  * No secrets, raw messages, tokens or downloaded data may be logged. */
 read(snapshot:ReadOnlyReceptionSnapshot,check:()=>Promise<void>):Promise<ReadOnlyReceptionBatch>;
}
export type ReadOnlyReceptionBinding={scope:ReceivedScope;connectionRevision:number;configurationSha256:string;
 approvalId:string;approvalRevision:number;sources:readonly ('MAIL'|'SIRE')[];approvedImapHosts:readonly string[]};
