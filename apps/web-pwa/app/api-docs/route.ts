import { documentationHeaders } from './_lib/server';
export const dynamic = 'force-dynamic';
export function GET(request:Request) {
  return new Response(null,{status:307,headers:{...documentationHeaders,Location:new URL('/api-reference',request.url).toString()}});
}
