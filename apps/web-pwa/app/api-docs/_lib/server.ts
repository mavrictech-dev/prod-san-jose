import { b2bPublicOpenApiV1 } from '@factuez/contracts/b2b-openapi';
import { connectionGuide } from './guide';

export const documentationHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
};
export const documentationJson = () => b2bPublicOpenApiV1();
export const swaggerAssets = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
  'swagger-ui-standalone-preset.js': 'text/javascript; charset=utf-8',
} as const;

// No OAuth console, token storage, external validator or arbitrary specification URL.
export const documentationInit = `"use strict";
window.ui = SwaggerUIBundle({
  url: '/api-docs/openapi.json', dom_id: '#swagger-ui', deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis], layout: 'BaseLayout',
  supportedSubmitMethods: [], tryItOutEnabled: false, persistAuthorization: false,
  validatorUrl: null, queryConfigEnabled: false, withCredentials: false,
  displayOperationId: true, showExtensions: true, defaultModelsExpandDepth: 0,
  requestInterceptor: function(request) {
    var url = new URL(request.url, window.location.origin);
    if (url.origin !== window.location.origin || url.search || url.hash || url.username || url.password || url.pathname !== '/api-docs/openapi.json' || (request.method || 'GET').toUpperCase() !== 'GET') {
      throw new Error('Swagger de referencia: no ejecuta peticiones, autenticación ni envíos.');
    }
    request.credentials = 'omit'; request.headers = {};
    return request;
  }
});
`;

// Existing FactuEz rose accent and system font. Static documentation, no motion or remote fonts.
export const documentationCss = `
:root{color-scheme:light;--ink:#172033;--muted:#475569;--accent:#9f1239;--line:#dbe2ea}
*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;background:#f8fafc;color:var(--ink);font:16px/1.65 system-ui,sans-serif}
a{color:var(--accent);text-underline-offset:3px}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:5px}
.docs-wrap{max-width:1200px;margin:auto;padding:0 32px}.docs-bar{display:flex;gap:24px;align-items:center;justify-content:space-between;min-height:72px;border-bottom:1px solid var(--line)}.docs-brand{font-size:20px;font-weight:750;color:var(--ink);text-decoration:none}
.docs-hero{padding:48px 0 24px;max-width:850px}h1{font-size:clamp(30px,4vw,44px);line-height:1.15;letter-spacing:-.035em;margin:0 0 16px}h2{font-size:27px;line-height:1.3;letter-spacing:-.02em;margin:0 0 18px}h3{font-size:20px;margin-top:28px}p{max-width:78ch;margin:12px 0}.docs-lead{font-size:19px;color:var(--muted);max-width:65ch}
.docs-notice{border-left:4px solid var(--accent);padding:14px 20px;background:#fff1f2;margin:0 0 28px;max-width:88ch}.docs-actions{display:flex;flex-wrap:wrap;gap:20px;align-items:center;margin:24px 0}.docs-button{display:inline-block;background:var(--accent);color:white;padding:10px 18px;border-radius:6px;font-weight:650;text-decoration:none;white-space:nowrap}
.docs-layout{display:grid;grid-template-columns:200px minmax(0,1fr);gap:48px;margin:36px 0 64px}.docs-index{align-self:start;position:sticky;top:24px}.docs-index strong{display:block;margin-bottom:12px}.docs-index a{display:block;padding:8px 0}.docs-content{min-width:0}.docs-content section{padding:0 0 36px;margin-bottom:32px;border-bottom:1px solid var(--line)}.docs-content li{margin:12px 0}.docs-content ol{padding-left:24px}
.docs-content code{font: .9em/1.55 ui-monospace,Consolas,monospace;overflow-wrap:anywhere;background:#e9eef4;padding:2px 5px;border-radius:4px}.docs-content pre{margin:20px 0;padding:20px;border:1px solid var(--line);background:white;border-radius:6px;max-width:100%;overflow:auto}.docs-content pre code{background:none;padding:0;white-space:pre;overflow-wrap:normal}.table-scroll{overflow-x:auto}.docs-content table{border-collapse:collapse;width:100%;font-size:14px;margin:20px 0}.docs-content caption{text-align:left;font-weight:650;margin-bottom:12px}.docs-content th,.docs-content td{text-align:left;vertical-align:top;padding:12px 10px;border-bottom:1px solid var(--line)}.docs-content th{font-weight:650}
.docs-skip{position:absolute;left:16px;top:-100px;background:white;padding:8px;z-index:5}.docs-skip:focus{top:12px}.docs-footer{color:var(--muted);border-top:1px solid var(--line);padding:24px 0}
.swagger-ui .auth-wrapper,.swagger-ui .authorize,.swagger-ui .authorization__btn,.swagger-ui .try-out{display:none!important}.swagger-ui .wrapper{max-width:1200px}.swagger-ui .info .title{font-size:26px}.swagger-ui .servers select{max-width:100%}
@media(max-width:760px){.docs-wrap{padding:0 20px}.docs-hero{padding-top:32px}.docs-layout{grid-template-columns:minmax(0,1fr);gap:28px;margin-top:24px}.docs-index{position:static;border-bottom:1px solid var(--line);padding-bottom:16px}.docs-index a{display:inline-block;margin-right:20px}.docs-bar{gap:12px;flex-wrap:wrap;padding:12px 0}.docs-content section{padding-bottom:24px}.docs-content pre{padding:14px}h2{font-size:24px}}
`;
function frame(title: string, body: string, swagger = false): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Guía B2B FactuEz: OAuth, originales XML/CDR y webhooks. Contratos de referencia con runtime no verificado."><title>${title}</title><link rel="icon" href="/favicon.ico">${swagger ? '<link rel="stylesheet" href="/api-docs/assets/swagger-ui.css">' : ''}<link rel="stylesheet" href="/api-docs/assets/docs.css"></head><body><a class="docs-skip" href="#contenido">Saltar al contenido</a><div class="docs-wrap"><header class="docs-bar"><a class="docs-brand" href="/api-docs">FactuEz / API B2B</a><a href="/login">Volver a FactuEz</a></header>${body}<footer class="docs-footer">Referencia contractual · Sin credenciales · Runtime no verificado</footer></div>${swagger ? '<script src="/api-docs/assets/swagger-ui-bundle.js"></script><script src="/api-docs/assets/init.js"></script>' : ''}</body></html>`;
}
const notice = '<div class="docs-notice"><strong>Runtime no verificado.</strong> Mostrar un contrato no confirma que sus servicios estén levantados o disponibles. Esta documentación no activa la API, producción ni transmisión fiscal.</div>';
export function documentationHtml(): string {
  return frame('FactuEz · Conexión B2B', `<main id="contenido"><div class="docs-hero"><h1>Conecta tu sistema con FactuEz</h1><p class="docs-lead">Guía B2B para autenticar servicios, extraer XML/CDR y recibir avisos de emisión local.</p><nav class="docs-actions" aria-label="Acceso al contrato"><a class="docs-button" href="/api-docs/swagger">Abrir Swagger</a><a href="/api-docs/openapi.json">OpenAPI B2B (JSON)</a></nav></div>${notice}<div class="docs-layout"><nav class="docs-index" aria-label="En esta guía"><strong>En esta guía</strong><a href="#conexion">Antes de conectar</a><a href="#oauth">OAuth y permisos</a><a href="#xml-cdr">XML y CDR</a><a href="#webhooks">Webhooks</a><a href="#errores">Errores y disponibilidad</a></nav><div class="docs-content">${connectionGuide}</div></div></main>`);
}
export function swaggerHtml(): string {
  return frame('FactuEz · Swagger B2B de referencia', `<main id="contenido"><div class="docs-hero"><h1>Swagger B2B</h1><p>Visor de sólo lectura: no solicita claves, no autentica y no ejecuta endpoints.</p><nav class="docs-actions"><a href="/api-docs">Guía de conexión</a><a href="/api-docs/openapi.json">OpenAPI B2B (JSON)</a></nav></div>${notice}<div id="swagger-ui"></div><noscript>Activa JavaScript para el visor o consulta el JSON y la guía de conexión.</noscript></main>`, true);
}
