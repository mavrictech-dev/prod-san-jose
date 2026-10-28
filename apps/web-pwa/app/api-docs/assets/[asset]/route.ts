import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAbsoluteFSPath } from 'swagger-ui-dist';
import { documentationCss, documentationHeaders, documentationInit, swaggerAssets } from '../../_lib/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  const { asset } = await context.params;
  if (asset === 'init.js' || asset === 'docs.css') return new Response(asset === 'init.js' ? documentationInit : documentationCss, { headers: { ...documentationHeaders, 'Content-Type': asset === 'init.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' } });
  if (!Object.hasOwn(swaggerAssets, asset)) return new Response('Recurso no disponible', { status: 404, headers: documentationHeaders });
  try {
    const bytes = await readFile(join(getAbsoluteFSPath(), asset));
    return new Response(new Uint8Array(bytes), { headers: { ...documentationHeaders, 'Content-Type': swaggerAssets[asset as keyof typeof swaggerAssets] } });
  } catch {
    return new Response('Documentación temporalmente no disponible', { status: 503, headers: documentationHeaders });
  }
}
