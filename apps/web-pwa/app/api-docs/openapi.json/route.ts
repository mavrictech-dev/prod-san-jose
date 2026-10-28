import { documentationHeaders, documentationJson } from '../_lib/server';
export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json(documentationJson(), { headers: documentationHeaders });
}
