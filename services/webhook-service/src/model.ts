import type {B2bBinding,B2bPrincipal} from '@factuez/contracts/b2b-security';
export type Actor=Pick<B2bPrincipal,'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>;
export const actorKey=(a:Actor)=>a.kind+':'+(a.subjectId??'-');
export interface Subscription {
  id:string;actor:Actor;binding:B2bBinding;label:string;destinationId:string;revision:number;enabled:boolean;
  verifiedRevision:number|null;secret:string;previousSecret:string|null;previousUntil:number|null;createdAt:number;
}
export interface LocalEvent {
  schemaVersion:'factuez.b2b.v1';eventId:string;eventType:'document.issued-locally.v1';operationId:string;commandId:string;
  draftId:string;documentId:string;context:B2bBinding;occurredAt:string;snapshotSha256:string;fiscalAcceptance:'NOT_ASSERTED';
}
export interface InboxEvent {id:string;hash:string;source:LocalEvent;body:string;at:number}
export type DeliveryState='PENDING'|'RUNNING'|'RETRY'|'DELIVERED'|'DEAD_LETTER'|'CANCELLED';
export interface Delivery {id:string;subscriptionId:string;eventId:string;destinationId:string;state:DeliveryState;attempts:number;round:number;
  dueAt:number;createdAt:number;deadline:number;lease:string|null;leaseUntil:number|null;lastCode:string|null;statusCode:number|null}
export interface Attempt {id:string;deliveryId:string;number:number;round:number;at:number;code:string;status:number|null}
export interface Command {owner:string;keyHash:string;bodyHash:string;response:unknown;at:number}
export interface Audit {id:string;owner:string;action:string;resourceId:string;at:number}
export interface HookTx {
  sub(id:string):Promise<Subscription|null>;putSub(s:Subscription):Promise<void>;subs(owner?:string,after?:string,limit?:number):Promise<Subscription[]>;
  event(id:string):Promise<InboxEvent|null>;putEvent(e:InboxEvent):Promise<void>;
  delivery(id:string):Promise<Delivery|null>;putDelivery(d:Delivery):Promise<void>;deliveries(owner:string,after?:string,limit?:number):Promise<Delivery[]>;
  due(now:number,limit:number):Promise<Delivery[]>;attempts(id:string):Promise<Attempt[]>;attempt(a:Attempt):Promise<void>;
  prior(owner:string,key:string):Promise<Command|null>;command(c:Command):Promise<void>;audit(a:Audit):Promise<void>;
}
export interface HookStore {transaction<T>(work:(tx:HookTx)=>Promise<T>):Promise<T>}
export interface DeliveryAuthority {check(actor:Actor,binding:B2bBinding):Promise<boolean>}
export interface CallbackTransport {send(destinationId:string,body:Buffer,headers:Record<string,string>):Promise<{status:number;retryAfterSeconds?:number}>;challenge(destinationId:string,challenge:string):Promise<boolean>;ids():string[]}
export const ownerKey=(a:Actor)=>a.clientId+':'+actorKey(a);
