import {TextDecoder} from 'node:util';
import {canonical, equal, inventory, list, record, requireThat, sha, snapshot as normalizeSnapshot, LIMITS} from './model';
import {PROFILE, type Inventory, type OwnerPort, type OwnerSnapshot} from './ports';

/** Fixture format only: REDIS0011 is a compatibility prefix, not a real RDB. No Redis client is used. */
const PREFIX = 'REDIS0011FACTUEZ_SYNTHETIC_V1\n';
const SCHEMA = 'factuez.synthetic.redis.strings.absolute-expiry.v1';
export interface SyntheticRedisEntry { key: string; value: string; expiresAt: string | null }
export interface SyntheticRedisState { epoch: number; entries: SyntheticRedisEntry[] }

function normalize(input: SyntheticRedisState): SyntheticRedisState {
  record(input, ['epoch', 'entries']);
  requireThat(Number.isSafeInteger(input.epoch) && input.epoch >= 1, 'REDIS_SYNTHETIC_EPOCH');
  list(input.entries, 1024);
  const entries = input.entries.map(entry => {
    record(entry, ['key', 'value', 'expiresAt']);
    requireThat(typeof entry.key === 'string' && /^synthetic:[a-z0-9:_-]{1,120}$/.test(entry.key) &&
      typeof entry.value === 'string' && Buffer.byteLength(entry.value) <= 4096, 'REDIS_SYNTHETIC_ENTRY');
    requireThat(entry.expiresAt === null || (typeof entry.expiresAt === 'string' &&
      Number.isFinite(Date.parse(entry.expiresAt)) && new Date(entry.expiresAt).toISOString() === entry.expiresAt), 'REDIS_SYNTHETIC_EXPIRY');
    return {...entry};
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  requireThat(new Set(entries.map(entry => entry.key)).size === entries.length, 'REDIS_SYNTHETIC_DUPLICATE');
  return {epoch: input.epoch, entries};
}
function describe(state: SyntheticRedisState): Inventory {
  return inventory({owner: 'REDIS', profile: PROFILE, schemaSha256: sha(SCHEMA),
    state: {count: state.entries.length, sha256: sha(canonical(state.entries))}, tables: [], sequences: [], files: [],
    checkpoints: [{name: 'epoch', sha256: sha(String(state.epoch))},
      {name: 'ttlPolicy', sha256: sha('ABSOLUTE_EXPIRY_NO_REPLAY')}]});
}
function decode(input: OwnerSnapshot): SyntheticRedisState {
  const value = normalizeSnapshot(input);
  requireThat(value.inventory.owner === 'REDIS' && value.files.length === 0 && value.payload.bytes.length <= LIMITS.dump, 'REDIS_SYNTHETIC_OWNER');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(value.payload.bytes);
  requireThat(text.startsWith(PREFIX), 'REDIS_SYNTHETIC_FORMAT');
  const raw = text.slice(PREFIX.length), parsed = JSON.parse(raw);
  requireThat(canonical(parsed) === raw, 'REDIS_SYNTHETIC_CANONICAL');
  const state = normalize(parsed);
  equal(describe(state), value.inventory, 'REDIS_SYNTHETIC_INVENTORY');
  return state;
}

/** Explicitly supplied fixture state; snapshots and verifications have no I/O or clock dependency. */
export class SyntheticRedisOwner implements OwnerPort {
  readonly owner = 'REDIS' as const;
  #state: SyntheticRedisState;
  constructor(state: SyntheticRedisState) { this.#state = normalize(state); }
  async inventory(): Promise<Inventory> { return describe(this.#state); }
  async snapshot(): Promise<OwnerSnapshot> {
    return {inventory: describe(this.#state), payload: {format: 'REDIS_RDB', bytes: Buffer.from(PREFIX + canonical(this.#state))}, files: []};
  }
  async verify(value: OwnerSnapshot): Promise<void> { decode(value); }
}

/** One-shot, in-memory target. Integrators must bind it to their own RestoreTargetPort identity checks. */
export class SyntheticRedisRestore {
  #state: SyntheticRedisState | undefined;
  restore(value: OwnerSnapshot): void {
    requireThat(this.#state === undefined, 'REDIS_SYNTHETIC_TARGET_NOT_EMPTY');
    this.#state = decode(value);
  }
  inventory(): Inventory {
    requireThat(this.#state !== undefined, 'REDIS_SYNTHETIC_TARGET_EMPTY');
    return describe(this.#state);
  }
  read(): SyntheticRedisState {
    requireThat(this.#state !== undefined, 'REDIS_SYNTHETIC_TARGET_EMPTY');
    return structuredClone(this.#state);
  }
}
