import {describe,it,expect} from 'vitest';
import {hookFixture,hookEvent} from './b2b-webhooks.fixture';
import {verifyWebhook} from '../services/webhook-service/src/crypto';
import {ctx} from './b2b-identity.fixture';
describe('B2B-05 durable subscriptions, inbox, dispatch and recovery',()=>{
  it('stores encrypted signing keys, reveals once and does not retain bearer/client secret',async()=>{
    const f=await hookFixture(),first=await f.create(),again=await f.create();expect(first.signingSecret).toMatch(/^whsec_/);expect(again.signingSecret).toBeUndefined();expect(again.id).toBe(first.id);
    const data=JSON.stringify([...[...f.store.subscriptions.values()],...[...f.store.commands.values()]]);expect(data).not.toContain(first.signingSecret);expect(data).not.toContain(f.token);expect(data).not.toContain(f.made.clientSecret);
  });
  it('requires verified approved destination; rejects a caller URL and unverified fiscal events',async()=>{
    const f=await hookFixture();await f.create();await f.core.ingest(hookEvent());expect(f.store.rows.size).toBe(0);
    await expect(f.call('CREATE',{key:'synthetic_hook_bad_001',body:{label:'Bad',destinationId:'https://127.0.0.1',url:'http://169.254.169.254',binding:hookEvent().context,events:[]}})).rejects.toMatchObject({status:400});
    await expect(f.core.ingest({...hookEvent(),eventType:'document.tax-acceptance-verified.v1'})).rejects.toMatchObject({status:422});
  });
  it('deduplicates an event plus fanout atomically across concurrent intake and lost ack',async()=>{
    const f=await hookFixture();await f.verified();const e=hookEvent(),r=await Promise.all(Array.from({length:8},()=>f.core.ingest(e)));expect(f.store.events.size).toBe(1);expect(f.store.rows.size).toBe(1);expect(new Set(r.map(x=>x.hash)).size).toBe(1);
    await expect(f.core.ingest({...e,snapshotSha256:'b'.repeat(64)})).rejects.toMatchObject({code:'EVENT_CONTENT_CONFLICT'});
  });
  it('does not confirm Inbox or deliveries when audit fails',async()=>{
    const f=await hookFixture();await f.verified();f.store.failAudit=true;await expect(f.core.ingest(hookEvent())).rejects.toThrow();expect(f.store.events.size).toBe(0);expect(f.store.rows.size).toBe(0);
  });
  it('delivers only a minimal signed event with stable delivery/event IDs and no XML/paths',async()=>{
    const f=await hookFixture(),s=await f.verified(),event=hookEvent();await f.core.ingest(event);await Promise.all([f.core.dispatch(),f.core.dispatch()]);expect(f.callbacks.send).toHaveBeenCalledTimes(1);
    const [,bytes,headers]=f.callbacks.send.mock.calls[0];expect(verifyWebhook([s.signingSecret],bytes,headers,f.now())).toBe([...f.store.rows.keys()][0]);
    const body=JSON.parse(bytes.toString());expect(body).toMatchObject({eventId:event.eventId,eventName:event.eventType,payload:{provenance:'LOCAL',resource:{id:event.documentId}}});expect(bytes.toString()).not.toMatch(/storageKey|customer|Bearer|https:|SIGNED_XML/);expect([...f.store.rows.values()][0].state).toBe('DELIVERED');
  });
  it('retries transient errors with the same bytes/delivery ID, a new timestamp and attempt ID',async()=>{
    const f=await hookFixture();await f.verified();await f.core.ingest(hookEvent());f.callbacks.send.mockResolvedValueOnce({status:503});await f.core.dispatch();const a=f.callbacks.send.mock.calls[0];expect([...f.store.rows.values()][0].state).toBe('RETRY');f.advance(31000);await f.core.dispatch();const b=f.callbacks.send.mock.calls[1];expect(a[1]).toEqual(b[1]);expect(a[2]['webhook-id']).toBe(b[2]['webhook-id']);expect(a[2]['X-FactuEz-Attempt-Id']).not.toBe(b[2]['X-FactuEz-Attempt-Id']);expect(a[2]['webhook-timestamp']).not.toBe(b[2]['webhook-timestamp']);
  });
  it('dead-letters permanent errors without redirects; explicit replay keeps event and delivery identity',async()=>{
    const f=await hookFixture(),s=await f.verified();await f.core.ingest(hookEvent());f.callbacks.send.mockResolvedValueOnce({status:302});await f.core.dispatch();const d=[...f.store.rows.values()][0];expect(d.state).toBe('DEAD_LETTER');
    const replay=await f.call('REPLAY',{id:d.id,key:'synthetic_hook_replay_001',ifMatch:s.revision,body:{}});expect(replay.id).toBe(d.id);expect(replay.round).toBe(1);await f.core.dispatch();expect(f.store.rows.get(d.id)?.state).toBe('DELIVERED');expect(f.store.events.size).toBe(1);
  });
  it('limits retries to eight and applies the 24-hour horizon',async()=>{
    const f=await hookFixture();await f.verified();await f.core.ingest(hookEvent());f.callbacks.send.mockResolvedValue({status:503});for(let i=0;i<8;i++){await f.core.dispatch();const d=[...f.store.rows.values()][0];f.advance(Math.max(0,d.dueAt-f.now()));}expect(f.callbacks.send).toHaveBeenCalledTimes(8);expect([...f.store.rows.values()][0].state).toBe('DEAD_LETTER');
    const g=await hookFixture();await g.verified();await g.core.ingest(hookEvent());g.advance(86400001);await g.core.dispatch();expect(g.callbacks.send).not.toHaveBeenCalled();expect([...g.store.rows.values()][0].state).toBe('DEAD_LETTER');
  });
  it('revocation cancels a queued delivery, while Identity outages retry without sending',async()=>{
    const f=await hookFixture();await f.verified();await f.core.ingest(hookEvent());await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());await f.core.dispatch();expect(f.callbacks.send).not.toHaveBeenCalled();expect([...f.store.rows.values()][0].state).toBe('CANCELLED');
    const g=await hookFixture();await g.verified();await g.core.ingest(hookEvent());g.authority.check.mockRejectedValueOnce(new Error('Synthetic Identity unavailable'));await g.core.dispatch();expect(g.callbacks.send).not.toHaveBeenCalled();expect([...g.store.rows.values()][0].state).toBe('RETRY');
  });
  it('rotates encrypted secrets with a five-minute overlap, not unlimited old-key validity',async()=>{
    const f=await hookFixture(),s=await f.verified();const rotated=await f.call('ROTATE',{id:s.id,key:'synthetic_hook_rotate_001',ifMatch:s.revision,body:{}});
    await f.core.ingest(hookEvent());await f.core.dispatch();const [,bytes,headers]=f.callbacks.send.mock.calls[0];expect(verifyWebhook([s.signingSecret],bytes,headers,f.now())).toBeTruthy();expect(verifyWebhook([rotated.signingSecret],bytes,headers,f.now())).toBeTruthy();
    f.advance(301000);await f.core.ingest(hookEvent());await f.core.dispatch();const [,b,h]=f.callbacks.send.mock.calls[1];expect(()=>verifyWebhook([s.signingSecret],b,h,f.now())).toThrow();expect(verifyWebhook([rotated.signingSecret],b,h,f.now())).toBeTruthy();
  });
  it('a destination/config change invalidates verification and stops already queued work',async()=>{
    const f=await hookFixture(),s=await f.verified();await f.core.ingest(hookEvent());await f.call('PATCH',{id:s.id,key:'synthetic_hook_patch_001',ifMatch:s.revision,body:{enabled:false}});await f.core.dispatch();expect(f.callbacks.send).not.toHaveBeenCalled();expect([...f.store.rows.values()][0].state).toBe('CANCELLED');
    await expect(f.call('ROTATE',{id:s.id,key:'synthetic_hook_rotate_002',ifMatch:s.revision,body:{}})).rejects.toMatchObject({status:412});
  });
  it('foreign clients cannot read another subscription or delivery by guessing IDs',async()=>{
    const f=await hookFixture(),g=await hookFixture(),s=await f.verified();g.store.subscriptions=f.store.subscriptions;await expect(g.call('GET',{id:s.id})).rejects.toMatchObject({status:404});
  });
  it('does not silently redirect an old queued delivery to a newly verified destination',async()=>{
    const f=await hookFixture(),s=await f.verified();await f.core.ingest(hookEvent());f.callbacks.ids=()=>['erp_approved','second_approved'];
    const changed=await f.call('PATCH',{id:s.id,key:'synthetic_destination_patch',ifMatch:s.revision,body:{destinationId:'second_approved'}});
    await f.call('VERIFY',{id:s.id,key:'synthetic_destination_verify',ifMatch:changed.revision,body:{}});await f.core.dispatch();expect(f.callbacks.send).not.toHaveBeenCalled();expect([...f.store.rows.values()][0].state).toBe('CANCELLED');
  });
});
