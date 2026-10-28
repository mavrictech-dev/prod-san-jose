import { documentationHeaders } from '../_lib/server';
export const dynamic = 'force-dynamic';
// The public catalogue must not expose the intranet administration contract.
export function GET() {
  return new Response('Recurso no disponible', { status: 404, headers: { ...documentationHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
}
