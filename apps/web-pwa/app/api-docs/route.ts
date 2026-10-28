import { documentationHeaders, documentationHtml } from './_lib/server';
export const dynamic = 'force-dynamic';
export function GET() {
  return new Response(documentationHtml(), { headers: { ...documentationHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}
