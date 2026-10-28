import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { AccessError } from '@factuez/service-access';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Only global unicast; excludes mapped IPv4, ULA, link local and transition tunnels.
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  const [prefix, subnet] = address.toLowerCase().split(':');
  return prefix !== '2002' && prefix !== '3fff' && !(prefix === '2001' && (parseInt(subnet || '0',16) <= 0x1ff || subnet === 'db8'));
}
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error || !addresses.length || addresses.some(a => !publicAddress(a.address))) {
      callback(new Error('RECEPTION_DNS_REJECTED'), '', 4); return;
    }
    const family = typeof options === 'number' ? options : options.family;
    const selected = addresses.find(a => !family || a.family === Number(family));
    if (!selected) { callback(new Error('RECEPTION_DNS_REJECTED'), '', 4); return; }
    // Node 20 autoSelectFamily requests all records. No second DNS lookup at connect time.
    if (typeof options === 'object' && options.all) (callback as Function)(null, addresses);
    else callback(null, selected.address, selected.family);
  });
};
export async function checkPublicHost(host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => publicLookup(host, {}, error => error ? reject(new AccessError(503, 'RECEPTION_DNS_REJECTED')) : resolve()));
}
/** Native HTTPS, strict trust/SNI and fresh public DNS on every request. Never follows redirects. */
export const receptionHttpsFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.protocol !== 'https:' || !['api-sire.sunat.gob.pe', 'api-seguridad.sunat.gob.pe'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('RECEPTION_ORIGIN_REJECTED');
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()),
      lookup: publicLookup, agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: url.hostname,
      signal: init.signal ?? undefined }, res => {
      const headers = new Headers(); for (const [key,value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      resolve(new Response(Readable.toWeb(res) as unknown as NonNullable<ConstructorParameters<typeof Response>[0]>, { status: res.statusCode ?? 502, headers }));
    });
    req.on('error', () => reject(new Error('RECEPTION_HTTPS_FAILED')));
    if (init.body !== undefined && typeof init.body !== 'string') { req.destroy(); reject(new Error('RECEPTION_BODY_REJECTED')); return; }
    req.end(init.body);
  });
};
