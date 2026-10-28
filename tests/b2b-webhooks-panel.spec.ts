import React from '../apps/web-pwa/node_modules/react';
import {renderToStaticMarkup} from '../apps/web-pwa/node_modules/react-dom/server';
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {WebhookPanel,webhookStateLabels} from '../apps/web-pwa/features/b2b/webhook-panel';
describe('B2B-05 integrable shadcn delivery panel',()=>{
  it('renders empty/loading context without inventing destinations or tax acceptance',()=>{
    const html=renderToStaticMarkup(React.createElement(WebhookPanel,{issuerId:1,client:{request:async()=>{throw new Error('SSR must not fetch');}}}));expect(html).toContain('Notificaciones a integraciones');expect(html).toContain('no significa aceptación');expect(html).toContain('No hay entregas');expect(html).not.toContain('whsec_');expect(webhookStateLabels.DELIVERED).toBe('Notificado');
  });
  it('requires an injected B2B client, preserves replay key and never uses PWA login tokens',()=>{
    const source=readFileSync(new URL('../apps/web-pwa/features/b2b/webhook-panel.tsx',import.meta.url),'utf8');expect(source).toContain('@factuez/ui/components/table');expect(source).toContain('@factuez/ui/components/dialog');expect(source).toContain("'Idempotency-Key':replay.key");expect(source).not.toMatch(/localStorage|sessionStorage|useWorkspace|Authorization:|fetch\(/);
  });
});
