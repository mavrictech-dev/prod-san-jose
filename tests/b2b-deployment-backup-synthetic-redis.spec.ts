import {describe, expect, it} from 'vitest';
import {SyntheticRedisOwner, SyntheticRedisRestore} from '../infra/b2b/deployment-backup/synthetic-redis';

const state = () => ({epoch: 9, entries: [
  {key: 'synthetic:queue:unknown', value: 'UNKNOWN', expiresAt: null},
  {key: 'synthetic:session:one', value: 'fixture', expiresAt: '2030-01-01T00:00:00.000Z'},
  {key: 'synthetic:queue:queued', value: 'QUEUED', expiresAt: null},
]});

describe('synthetic Redis owner and isolated restore', () => {
  it('round trips sorted entries, absolute expiry and queue states with matching inventory', async () => {
    const source = new SyntheticRedisOwner(state());
    const saved = await source.snapshot(); await source.verify(saved);
    const target = new SyntheticRedisRestore(); target.restore(saved);
    expect(target.inventory()).toEqual(await source.inventory());
    expect(target.read().entries).toEqual([...state().entries].sort((a, b) => a.key.localeCompare(b.key)));
    target.read().entries[0].value = 'changed';
    expect(target.inventory()).toEqual(await source.inventory());
    expect(() => target.restore(saved)).toThrow('TARGET_NOT_EMPTY');
  });
  it('rejects corrupted bytes or inventory before the empty target is modified', async () => {
    const owner = new SyntheticRedisOwner(state()); const saved = await owner.snapshot();
    const target = new SyntheticRedisRestore();
    const altered = {...saved, payload: {...saved.payload, bytes: Buffer.from(saved.payload.bytes)}};
    altered.payload.bytes[altered.payload.bytes.length - 2] ^= 1;
    expect(() => target.restore(altered)).toThrow();
    expect(() => target.inventory()).toThrow('TARGET_EMPTY');
    const wrongInventory = {...saved, inventory: {...saved.inventory, state: {...saved.inventory.state, count: 99}}};
    await expect(owner.verify(wrongInventory)).rejects.toThrow();
    expect(() => target.restore(wrongInventory)).toThrow();
    target.restore(saved); expect(target.inventory()).toEqual(await owner.inventory());
  });
  it('rejects duplicate keys, non-synthetic keys and invalid expirations', () => {
    expect(() => new SyntheticRedisOwner({epoch: 1, entries: [state().entries[0], state().entries[0]]})).toThrow();
    expect(() => new SyntheticRedisOwner({epoch: 1, entries: [{key: 'real:key', value: 'x', expiresAt: null}]})).toThrow();
    expect(() => new SyntheticRedisOwner({epoch: 1, entries: [{key: 'synthetic:x', value: 'x', expiresAt: 'tomorrow'}]})).toThrow();
  });
  it('does not treat a real RDB header or arbitrary fixture as this format', async () => {
    const owner = new SyntheticRedisOwner(state()); const saved = await owner.snapshot();
    await expect(owner.verify({...saved, payload: {format: 'REDIS_RDB', bytes: Buffer.from('REDIS0011other')}})).rejects.toThrow();
  });
});
