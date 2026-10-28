import { deny, plain, readQuery, requireIssuer, requireScopes, snapshotHash, uuid, type ReadIdentity } from './integration';
import { readIntegrationJournal, type JournalPage, type JournalPosition, type JournalOwner } from './integration-journal';
export interface OwnerJournalReader { read(ruc:string, after:JournalPosition|null, limit?:number):Promise<JournalPage> }
/** Adapter uses ONLY the owner's connection, no integration gateway fiscal database access. */
export class PrismaOwnerJournal implements OwnerJournalReader {
  constructor(private readonly db:any,private readonly owner:JournalOwner='BILLING') {}
  read(ruc:string,after:JournalPosition|null,limit=500):Promise<JournalPage> {
    return this.db.$transaction(async(tx:any)=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return readIntegrationJournal({query:async(sql:string,values:unknown[]=[])=>({rows:await tx.$queryRawUnsafe(sql,...values)})},ruc,after,limit,this.owner);
    },{isolationLevel:'RepeatableRead'});
  }
}
export class OwnerChanges {
  constructor(private readonly repository:OwnerJournalReader,private readonly identity:ReadIdentity) {}
  async ready(token:string,query:unknown) {
    const q=readQuery(query,['issuerRuc','environment']);
    const p=await this.identity.authenticate(token,['integration:catalog:read']);requireScopes(p,['integration:catalog:read']);requireIssuer(p,q.issuerRuc);
    await this.repository.read(q.issuerRuc,null,1);
    const final=await this.identity.authenticate(token,['integration:catalog:read']);requireScopes(final,['integration:catalog:read']);
    if(snapshotHash(p)!==snapshotHash(final))return deny(401,'UNAUTHENTICATED');return {ready:true};
  }
  async read(token:string,query:unknown) {
    const q=readQuery(query,['issuerRuc','environment','epoch','after','limit']);
    if ((q.epoch === undefined)!==(q.after === undefined) ||
        (q.epoch !== undefined && !uuid(q.epoch)) || (q.after !== undefined && !/^(0|[1-9][0-9]{0,18})$/.test(q.after)) ||
        (q.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(q.limit)) || Number(q.limit??500)>500) return deny(400,'INVALID_QUERY');
    // Journal metadata is private to service peers. It is never a public change page.
    const scopes=q.after===undefined?['integration:documents:read'] as const:['integration:documents:read','integration:changes:read'] as const;
    const p=await this.identity.authenticate(token,[...scopes]);requireScopes(p,[...scopes]);requireIssuer(p,q.issuerRuc);
    const page=await this.repository.read(q.issuerRuc,q.after===undefined?null:{epoch:q.epoch,sequence:q.after},Number(q.limit??500));
    if (!plain(page)) return deny(503,'CHANGE_FEED_NOT_READY');
    const final=await this.identity.authenticate(token,[...scopes]);requireScopes(final,[...scopes]);
    if(snapshotHash(final)!==snapshotHash(p)) return deny(401,'UNAUTHENTICATED');return page;
  }
}
