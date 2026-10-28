import { documentationHeaders, swaggerHtml } from '../_lib/server';
export const dynamic = 'force-dynamic';
export function GET() {
  return new Response(swaggerHtml(), { headers: { ...documentationHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}
