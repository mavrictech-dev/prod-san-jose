import {randomUUID} from 'node:crypto';
import {snapshotHash} from '@factuez/service-access/dist/integration';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import type {DraftDatabase} from './draft-store';
export interface WebhookInboxPort {accept(event:unknown):Promise<unknown>}
export class HttpWebhookInbox implements WebhookInboxPort {
  constructor(private readonly http:B2bPrivateHttp){}
  accept(event:unknown){return this.http.post('/internal/b2b/webhook-events',event);}
}
/** Independent post-commit publisher; never reads/updates legacy OutboxEvent. */
export class B2bCommitPublisher {
  private stopping=false;private active=new Set<Promise<boolean>>();private closing?:Promise<void>;
  constructor(private readonly db:DraftDatabase,private readonly inbox:WebhookInboxPort,private readonly now=Date.now){}
  flush():Promise<boolean>{
    if(this.stopping)return Promise.resolve(false);
    const work=Promise.resolve().then(()=>this.flushOne());this.active.add(work);
    void work.then(()=>this.active.delete(work),()=>this.active.delete(work));return work;
  }
  close():Promise<void>{
    if(this.closing)return this.closing;this.stopping=true;
    this.closing=Promise.allSettled([...this.active]).then(results=>{if(results.some(r=>r.status==='rejected'))throw new Error('B2B_COMMIT_PUBLISHER_CLOSE_FAILED');});
    return this.closing;
  }
  private async flushOne(){
    const lease=randomUUID(),row=await this.db.$transaction(async tx=>{
      const rows=await tx.$queryRawUnsafe<any[]>(`SELECT "id","payload" FROM "B2bCommitEvent" WHERE "fannedOutAt" IS NULL AND ("fanoutLeaseUntil" IS NULL OR "fanoutLeaseUntil"<=$1::timestamptz) ORDER BY "createdAt","id" LIMIT 1 FOR UPDATE SKIP LOCKED`,new Date(this.now()));
      if(!rows[0])return null;await tx.$executeRawUnsafe(`UPDATE "B2bCommitEvent" SET "fanoutLease"=$2::uuid,"fanoutLeaseUntil"=$3::timestamptz,"fanoutAttempts"="fanoutAttempts"+1 WHERE "id"=$1::uuid`,rows[0].id,lease,new Date(this.now()+60000));return rows[0];
    },{timeout:10000,maxWait:3000});if(!row)return false;
    try{const ack:any=await this.inbox.accept(row.payload);if(ack?.accepted!==true||ack.eventId!==row.id||ack.hash!==snapshotHash(row.payload))throw new Error('Invalid durable ack');
      await this.db.$transaction(tx=>tx.$executeRawUnsafe(`UPDATE "B2bCommitEvent" SET "fannedOutAt"=$3::timestamptz,"fanoutLease"=NULL,"fanoutLeaseUntil"=NULL,"fanoutLastCode"=NULL WHERE "id"=$1::uuid AND "fanoutLease"=$2::uuid`,row.id,lease,new Date(this.now())),{timeout:10000,maxWait:3000});
    }catch{await this.db.$transaction(tx=>tx.$executeRawUnsafe(`UPDATE "B2bCommitEvent" SET "fanoutLease"=NULL,"fanoutLeaseUntil"=$3::timestamptz,"fanoutLastCode"='INBOX_ACK_UNAVAILABLE' WHERE "id"=$1::uuid AND "fanoutLease"=$2::uuid`,row.id,lease,new Date(this.now()+30000)),{timeout:10000,maxWait:3000});}
    return true;
  }
}
