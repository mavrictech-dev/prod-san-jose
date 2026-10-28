import type {GuideDispatchKey,GuideDispatchManifest,GuideDispatchEvent} from '@factuez/sunat-core/dist/guide-dispatch-journal';
export type GuideDispatchRecord={manifest:GuideDispatchManifest;events:GuideDispatchEvent[]};
export interface GuideDispatchTransaction{
  read():Promise<GuideDispatchRecord|null>;
  register(manifest:GuideDispatchManifest,event:GuideDispatchEvent):Promise<void>;
  append(event:GuideDispatchEvent,expectedRevision:number):Promise<void>;
}
export interface GuideDispatchStore{
  transaction<T>(key:GuideDispatchKey,work:(tx:GuideDispatchTransaction)=>Promise<T>):Promise<T>;
}
/** Private owner-specific metadata port. Not an HTTP request or public claim.
 * LOCAL_EMULATOR is deliberately incompatible with the official GRE adapter. */
export interface GuideDispatchOwner{current(key:GuideDispatchKey):Promise<GuideDispatchManifest|null>}
export interface GuideDispatchEmulator{
  readonly mode:'ISOLATED_LOCAL_EMULATOR';
  submit(manifest:GuideDispatchManifest,attemptId:string,signal:AbortSignal):Promise<{ticket:string}>;
  findTicket(manifest:GuideDispatchManifest,attemptId:string,signal:AbortSignal):Promise<{ticket:string}|null>;
  poll(manifest:GuideDispatchManifest,ticket:string,signal:AbortSignal):Promise<{state:'PENDING'}|{state:'RESULT';receiptSha256:string}>;
}
