import {createHash} from 'node:crypto';
import {Webhook} from 'standardwebhooks';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import type {HookPool} from './store';
export interface ReceiverInbox {accept(deliveryId:string,eventId:string,bodySha256:string,payload:unknown):Promise<'ACCEPTED'|'DUPLICATE'>}
/** Consumer-owned DB. A real consumer must commit its business effect in this same transaction. */
export class PostgresReceiverInbox implements ReceiverInbox {
  constructor(private readonly pool:HookPool){}
  async accept(deliveryId:string,eventId:string,hash:string,payload:unknown):Promise<'ACCEPTED'|'DUPLICATE'>{const db=await this.pool.connect();
    try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(1985126507)');
      const old=await db.query('SELECT "eventId","bodySha256" FROM "WebhookReceiverInbox" WHERE "eventId"=$1::uuid OR "deliveryId"=$2::uuid',[eventId,deliveryId]);
      if(old.rows.length){if(old.rows.some(x=>x.eventId!==eventId||x.bodySha256!==hash))throw new Error('Receiver event conflict');await db.query('COMMIT');return 'DUPLICATE';}
      await db.query('INSERT INTO "WebhookReceiverInbox" ("eventId","deliveryId","bodySha256","payload") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb)',[eventId,deliveryId,hash,JSON.stringify(payload)]);await db.query('COMMIT');return 'ACCEPTED';
    }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}}
}
/** Reference receiver: ACK only after the consumer's durable Inbox commit. */
export class ReferenceReceiver {
  constructor(private readonly secrets:()=>readonly string[],private readonly inbox:ReceiverInbox){}
  async receive(bytes:Buffer,headers:Record<string,string>){
    if(bytes.length>16384)throw new Error('Invalid webhook');let event:any,valid=false;
    for(const secret of this.secrets()){try{event=new Webhook(secret).verify(bytes,headers);valid=true;break;}catch{}}
    if(!valid||!event||Object.keys(event).sort().join(',')!=='correlationId,environment,eventId,eventName,issuerId,occurredAt,payload,schemaVersion'||event.schemaVersion!=='factuez.webhook.v1'||event.eventName!=='document.issued-locally.v1'||event.environment!=='BETA'||
      !b2bUuid(event.eventId)||!b2bUuid(event.correlationId)||!Number.isSafeInteger(event.issuerId)||event.issuerId<1||!Number.isFinite(Date.parse(event.occurredAt))||!b2bUuid(headers['webhook-id'])||
      !event.payload||Object.keys(event.payload).sort().join(',')!=='provenance,resource'||event.payload.provenance!=='LOCAL'||event.payload.resource?.kind!=='DOCUMENT'||!b2bUuid(event.payload.resource.id)||
      Object.keys(event.payload.resource).sort().join(',')!=='id,kind,version'||!/^sha256:[a-f0-9]{64}$/.test(event.payload.resource.version))throw new Error('Invalid webhook');
    return this.inbox.accept(headers['webhook-id'],event.eventId,createHash('sha256').update(bytes).digest('hex'),event);
  }
}
