import { documentationHeaders } from './_lib/server';
export const dynamic = 'force-dynamic';
export function GET(_request:Request) {
  // A relative redirect preserves the public origin behind Kong and Docker.
  return new Response(null,{status:307,headers:{...documentationHeaders,Location:'/api-reference'}});
}
