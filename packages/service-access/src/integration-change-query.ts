import { deny, plain, readQuery } from './integration';
/** Checkpoint carries immutable filters; callers cannot broaden them on subsequent pages. */
export function changeQuery(value: unknown) {
  if (!plain(value)) return deny(400, 'INVALID_QUERY');
  const q = readQuery(value, ['issuerRuc', 'environment', 'checkpoint', 'limit'], ['issuerRuc', 'checkpoint']);
  if (!/^[A-Za-z0-9_-]{16,4096}$/.test(q.checkpoint) ||
      (q.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(q.limit))) return deny(400, 'INVALID_QUERY');
  const limit = q.limit === undefined ? 100 : Number(q.limit);
  if (limit > 500) return deny(400, 'INVALID_QUERY');
  return { issuerRuc: q.issuerRuc, checkpoint: q.checkpoint, limit };
}
