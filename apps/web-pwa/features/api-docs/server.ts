import { integrationSwaggerV1, sunatAdministrationOpenApiV1 } from '@factuez/contracts/integration-openapi';

export const documentationHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
};

export function documentationJson(kind: 'integration' | 'sunat') {
  return kind === 'integration' ? integrationSwaggerV1() : sunatAdministrationOpenApiV1();
}

// All assets are local, fixed and versioned by pnpm-lock. No CDN, remote validator or OAuth console.
export const swaggerAssets = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
  'swagger-ui-standalone-preset.js': 'text/javascript; charset=utf-8',
} as const;

export const documentationInit = `"use strict";
window.ui = SwaggerUIBundle({
  urls: [
    { name: 'Extracción privada ERP · activación TI pendiente', url: '/api-docs/openapi.json' },
    { name: 'SUNAT y consultas intranet · sesión humana', url: '/api-docs/sunat.json' }
  ],
  'urls.primaryName': 'Extracción privada ERP · activación TI pendiente',
  dom_id: '#swagger-ui', deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: 'StandaloneLayout',
  supportedSubmitMethods: [], tryItOutEnabled: false, persistAuthorization: false,
  validatorUrl: null, queryConfigEnabled: false, withCredentials: false,
  displayRequestDuration: false, displayOperationId: true, showExtensions: true,
  defaultModelsExpandDepth: 0,
  requestInterceptor: function(request) {
    var url = new URL(request.url, window.location.origin);
    var allowed = ['/api-docs/openapi.json', '/api-docs/sunat.json'];
    if (url.origin !== window.location.origin || url.search || allowed.indexOf(url.pathname) < 0 || (request.method || 'GET').toUpperCase() !== 'GET') {
      throw new Error('Swagger de referencia: no ejecuta peticiones, autenticación ni envíos.');
    }
    request.credentials = 'omit'; request.headers = request.headers || {};
    delete request.headers.Authorization; delete request.headers.authorization;
    return request;
  }
});
`;

export const documentationCss = `
html{color-scheme:light}body{margin:0;background:#f8fafc;color:#172033;font:15px/1.6 system-ui,sans-serif}
.docs-heading{max-width:1400px;margin:auto;padding:28px 24px 16px}.docs-heading h1{font-size:27px;line-height:1.2;margin:8px 0 12px}.docs-heading p{margin:8px 0;max-width:1000px}
.docs-eyebrow{font-size:12px;font-weight:700;letter-spacing:.1em;color:#9f1239}.docs-links{display:flex;flex-wrap:wrap;gap:16px;margin:16px 0}.docs-links a{color:#9f1239;font-weight:600}
.docs-notice{border:1px solid #fcd34d;border-radius:10px;background:#fffbeb;padding:14px 18px;margin:18px 0}.docs-heading details{border:1px solid #dbe2ea;border-radius:10px;background:white;padding:14px 18px}.docs-heading summary{font-weight:600;cursor:pointer}
.docs-heading code{font-size:.9em;background:#eef2f6;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}.docs-heading table{border-collapse:collapse;width:100%;font-size:14px}.docs-heading td,.docs-heading th{text-align:left;border-bottom:1px solid #e2e8f0;padding:8px}.docs-heading ol{padding-left:22px}
.swagger-ui .auth-wrapper,.swagger-ui .authorize,.swagger-ui .authorization__btn,.swagger-ui .try-out,.swagger-ui .download-url-wrapper .download-url-button{display:none!important}
.swagger-ui .topbar{background:#172033}.swagger-ui .wrapper{max-width:1400px}.swagger-ui .info .title{font-size:25px}
@media(max-width:640px){.docs-heading{padding:20px 16px}.docs-heading h1{font-size:23px}.docs-heading table{display:block;overflow-x:auto}.swagger-ui .topbar .download-url-wrapper{flex-wrap:wrap}.swagger-ui .topbar .download-url-wrapper select{max-width:100%}}
`;

export function documentationHtml(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FactuEz · Swagger y conexión privada</title><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/api-docs/assets/swagger-ui.css"><link rel="stylesheet" href="/api-docs/assets/docs.css"></head><body>
<header class="docs-heading"><span class="docs-eyebrow">FACTUEZ · DOCUMENTACIÓN TÉCNICA</span><h1>Endpoints y conexión privada</h1>
<p>Dos contratos separados: extracción para el ERP y configuración/consulta SUNAT dentro de la intranet. El selector de Swagger permite cambiar entre ambos.</p>
<div class="docs-notice"><strong>Visor de sólo lectura.</strong> No solicita claves ni ejecuta endpoints. Ver una ruta aquí no la habilita. La API privada necesita activación autorizada de TI; no está publicada por esta pantalla. Producción y envío fiscal oficial no se activan al cargar un certificado.</div>
<nav class="docs-links"><a href="/api-docs/openapi.json">OpenAPI extracción (JSON)</a><a href="/api-docs/sunat.json">OpenAPI SUNAT/intranet (JSON)</a><a href="/sunat-settings">Configuración SUNAT</a><a href="/login">Volver a FactuEz</a></nav>
<details><summary>Cómo se conectará el cliente para extraer comprobantes, XML y CDR</summary>
<p><strong>ERP autorizado → VPN privada → HTTPS/Kong → API de integración → Identity / Billing / SUNAT-lector.</strong> Los puertos de base de datos, los servicios propietarios y la configuración SUNAT no se publican al ERP.</p>
<ol><li>TI configura VPN, DNS privado, HTTPS, certificados de transporte y servicios de lectura. Da de alta un cliente técnico y sus permisos por RUC, sede, punto, serie y tipo.</li>
<li>El backend del ERP obtiene un token corto mediante <code>POST /integration/oauth/token</code>, HTTP Basic y <code>grant_type=client_credentials</code>. No usa SOL, P12 ni una cuenta de caja. No guardar secretos en aplicaciones de navegador.</li>
<li>Consulta <code>GET /integration/v1/capabilities</code> y después <code>GET /integration/v1/documents</code>, con RUC y fechas. Sigue <code>nextCursor</code> sin cambiar filtros. El detalle incluye cliente, ítems, impuestos y totales.</li>
<li>Consulta <code>GET /integration/v1/documents/{documentId}/artifacts</code>. Elige el archivo por su clase y estado; descarga con <code>GET /integration/v1/artifacts/{artifactId}/content</code>, enviando Bearer y RUC. Nunca se pasan rutas del servidor.</li>
<li>Para lotes grandes, crea <code>POST /integration/v1/exports</code>, consulta su estado/manifiesto y descarga el ZIP cuando esté READY. El paquete contiene JSONL y los archivos solicitados, si están disponibles.</li>
<li>Para sincronizaciones posteriores, procesa <code>GET /integration/v1/changes</code> desde el checkpoint del corte y guarda el siguiente checkpoint sólo después de procesar el lote. Deduplica por eventId.</li></ol>
<table><thead><tr><th>Documento</th><th>Cobertura del lector empresarial actual</th></tr></thead><tbody><tr><td>01 factura · 03 boleta · 07 NC · 08 ND</td><td>Lectura implementada; requiere documentos persistidos, permisos, archivos y despliegue válidos.</td></tr><tr><td>09 GRE · 31 guía transportista</td><td>SOURCE_NOT_SUPPORTED en este lector. Los laboratorios/plantillas no son originales disponibles para extracción.</td></tr></tbody></table>
<p><strong>XML firmado, CDR y PDF son archivos distintos.</strong> Un CDR de resumen puede pertenecer a varias boletas: sólo se entrega si se autoriza el lote completo. Un PDF actual puede cambiar de diseño; los XML/CDR originales no se modifican.</p>
<p>La extracción lee lo almacenado en FactuEz: no contacta SUNAT en cada descarga. SHA correcto no acredita firma, confianza PKI ni aceptación fiscal. Las compras recibidas/SIRE son otro dominio y no se incluyen en esta API de emitidos.</p></details></header>
<main id="swagger-ui"></main><script src="/api-docs/assets/swagger-ui-bundle.js"></script><script src="/api-docs/assets/swagger-ui-standalone-preset.js"></script><script src="/api-docs/assets/init.js"></script></body></html>`;
}
