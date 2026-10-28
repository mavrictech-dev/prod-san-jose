import {canonical,deny,hash} from '@factuez/service-access/dist/b2b-production-contract';
import type {ProductionBillingSql} from './production-native-billing';
import type {ProductionWebhooks,ProductionEvent} from './production-webhooks';
/** Trusted native publisher calls after its business/outbox commit and before acknowledging relay.
 * Does not change publishedAt, consume BETA events, or replace native fiscal dispatch. */
export class ProductionNativeOutboxRelay {
 constructor(private readonly db:ProductionBillingSql,private readonly hooks:ProductionWebhooks){}
 async accept(source:'BILLING_OUTBOX'|'NOTES_OUTBOX',eventId:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(eventId))deny(400,'INVALID_NATIVE_EVENT_ID');let rows:Array<{payload:any}>;
 if(source==='BILLING_OUTBOX')rows=await this.db.$queryRawUnsafe<Array<{payload:any}>>('SELECT "payload" FROM "OutboxEvent" WHERE "id"=$1::uuid',eventId);
 else if(source==='NOTES_OUTBOX')rows=await this.db.$queryRawUnsafe<Array<{payload:any}>>('SELECT "payload" FROM "ProductionNotesOutbox" WHERE "id"=$1::uuid',eventId);
 else return deny(400,'INVALID_NATIVE_OUTBOX_SOURCE');
 const e=rows[0]?.payload,name=e?.eventName??e?.eventType;if(!e||e.eventId!==eventId||!['billing.document.issued.v1','billing.production.notes.issued.v1','billing.production-guides.issued.v1'].includes(name))deny(400,'UNSUPPORTED_NATIVE_EVENT');
 const snapshot=name==='billing.document.issued.v1'?e.payload:name==='billing.production.notes.issued.v1'?e.payload?.snapshot:e.snapshot;
 if(!snapshot||typeof snapshot.documentId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(snapshot.documentId))deny(400,'INVALID_NATIVE_SNAPSHOT');
 const native=await this.db.$queryRawUnsafe<any[]>(`SELECT d."immutableSnapshot",d."series",d."issueDate",c."ruc",p."id" AS "pointId",p."branchId" FROM "Document" d JOIN "CompanySettings" c ON c."id"=d."companyId" JOIN "EmissionPoint" p ON p."id"=d."emissionPointId" AND p."companyId"=c."id" WHERE d."id"=$1::uuid AND c."environment"='PRODUCTION' AND d."status"='ISSUED' LIMIT 1`,snapshot.documentId);
 const n=native[0];if(!n||canonical(n.immutableSnapshot)!==canonical(snapshot))deny(403,'NATIVE_EVENT_SNAPSHOT_MISMATCH');const code=snapshot.documentTypeCode??snapshot.documentType;
 if(name==='billing.document.issued.v1'&&!['01','03'].includes(code)||name==='billing.production.notes.issued.v1'&&!['07','08'].includes(code)||name==='billing.production-guides.issued.v1'&&!['09','31'].includes(code))deny(400,'NATIVE_EVENT_TYPE_MISMATCH');
 const event:ProductionEvent={environment:'PRODUCTION',eventId,eventName:name==='billing.document.issued.v1'?'document.issued':name==='billing.production.notes.issued.v1'?'note.issued':'guide.issued',binding:{ruc:n.ruc,branchId:n.branchId,pointId:n.pointId,series:n.series},occurredAt:new Date(n.issueDate).toISOString(),resource:{id:snapshot.documentId,version:'sha256:'+hash(canonical(snapshot))}};
 return this.hooks.enqueue(event);
 }
}

