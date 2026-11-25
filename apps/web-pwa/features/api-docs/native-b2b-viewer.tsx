"use client";
import {useEffect,useMemo,useState} from 'react';
import {privateSwaggerDocument} from './private-viewer';
import {ErrorState,Loading,PageHeading} from '../workspace/common';
import {Card,CardHeader,CardTitle,CardContent} from '@factuez/ui/components/card';
const example=`// Node.js. Credenciales en variables de entorno del servidor consumidor.
const base = process.env.FACTUEZ_URL;
const basic = Buffer.from(process.env.FACTUEZ_CLIENT_ID + ':' +
  process.env.FACTUEZ_CLIENT_SECRET).toString('base64');
const scopes = 'production:masters:read production:documents:read production:documents:issue:01';
const tokenResponse = await fetch(base + '/b2b/oauth/token', {
  method: 'POST', headers: {Authorization: 'Basic ' + basic,
    'Content-Type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({grant_type: 'client_credentials', scope: scopes})
});
if (!tokenResponse.ok) throw await tokenResponse.json();
const {access_token} = await tokenResponse.json();
const headers = {Authorization: 'Bearer ' + access_token};
const issuers = await fetch(base + '/b2b/v1/issuers', {headers}).then(r => r.json());
// Seleccione IDs de los GET de branches, points, series y products.
// GET /products exige issuerRuc y branchId para resolver el IGV efectivo.
// Para recorrer páginas, reenvíe nextAfter en el parámetro after.
const request = {
  binding: {ruc: 'RUC_DEL_GET', branchId: 'UUID_SEDE', pointId: 'UUID_PUNTO', series: 'F001'},
  payload: {
    documentType: 'INVOICE', emissionPointId: 'UUID_PUNTO', series: 'F001',
    currencyCode: 'PEN', paymentTerms: {type: 'CONTADO'},
    customer: {identityType: '6', identityNumber: 'RUC_CLIENTE', legalName: 'CLIENTE'},
    lines: [{productId: 'UUID_PRODUCTO', description: 'PRODUCTO', unitCode: 'GLL',
      quantity: '1', unitPriceWithTax: '21.00', taxAffectationCode: '10', igvRate: '18'}]
  }
};
// Guarde esta clave y el cuerpo ANTES de enviar; reutilícelos si se pierde la respuesta.
const key = crypto.randomUUID();
const result = await fetch(base + '/b2b/v1/documents', {
  method: 'POST', headers: {...headers, 'Content-Type': 'application/json',
    'Idempotency-Key': key}, body: JSON.stringify(request)
});
const registered = await result.json();
if (!result.ok) {
  // fieldErrors indica el dato que debe corregirse.
  // operationId permite GET /b2b/v1/operations/{id}.
  // UNCERTAIN/PENDING: conciliar; no reenviar con otra clave.
  throw registered;
}
// 202 sólo confirma registro. Consultar aceptación y archivos por separado.
const status = await fetch(base + '/b2b/v1/documents/' + registered.documentId + '/status', {headers});
const xml = await fetch(base + '/b2b/v1/documents/' + registered.documentId + '/artifacts/xml', {headers});
// /artifacts/pdf?format=a4 o ticket; /artifacts/cdr devuelve ZIP original.
// Verifique X-Content-SHA256 al guardar los bytes; 409 indica archivo/evidencia pendiente.`;
export function NativeB2bViewer(){
 const [spec,setSpec]=useState<unknown>(),[error,setError]=useState<string>();
 useEffect(()=>{const controller=new AbortController();fetch('/b2b-production.openapi.json',{signal:controller.signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('No se pudo cargar el contrato de la API.');setSpec(await r.json());}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[]);
 const html=useMemo(()=>spec?privateSwaggerDocument(spec,crypto.randomUUID()):undefined,[spec]);
 return <div className="space-y-6"><PageHeading eyebrow="INTEGRACIÓN · PRODUCCIÓN" title="API B2B de FactuEz" description="GET para preparar solicitudes. POST para registrar documentos con una clave de idempotencia. Autorización por aplicación, RUC, sede, punto y serie."/>
 <div className="flex flex-wrap gap-4 text-sm"><a className="underline" href="/integrations#b2b-access">Administrar aplicaciones</a><a className="underline" href="/b2b-production.openapi.json" download>Descargar OpenAPI 3.1</a><a className="underline" href="/api-reference">API de administración</a></div>
 <Card><CardHeader><CardTitle>Preparar y emitir</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><ol className="list-decimal space-y-2 pl-5"><li>Cree una aplicación en Conexiones. Asigne consulta de maestros, consulta de documentos y emisión a las series necesarias.</li><li>Obtenga un token con Client ID y Client Secret de FactuEz. Dura 300 segundos; no use credenciales SOL ni GRE SUNAT.</li><li>Consulte emisores, sedes, puntos, series y productos. Los GET no consumen números. Use los códigos tributarios y las unidades del catálogo.</li><li>Envíe el documento con POST e Idempotency-Key. Para notas consulte primero el original aceptado y notes/prepare. Para guías consulte guides/capabilities.</li><li>Consulte estado y descargue XML firmado, PDF o CDR. Un ticket o una respuesta 202 todavía no acreditan aceptación.</li></ol><p>La emisión usa los mismos perfiles y requisitos de la pantalla. Las guías de combustible necesitan catálogo, ruta, modalidad y concesión revisados. GNV móvil, GRE-BF y rutas especiales requieren un perfil adicional.</p></CardContent></Card>
 <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">Ejemplo de integración en Node.js</summary><pre className="mt-4 overflow-x-auto rounded-md bg-muted p-4 text-xs"><code>{example}</code></pre></details>
 <Card><CardHeader><CardTitle>Errores y reintentos</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>Una respuesta de error incluye code, message, requestId y fieldErrors. Los errores de ítem indican su posición, por ejemplo lines[0].taxAffectationCode. El código 10 significa gravado; 18 es el porcentaje, no el código.</p><p>Si una operación queda PENDING o UNCERTAIN, consulte su operationId y revise nativeDocument antes de repetir. Conserve la clave y el cuerpo originales. Una respuesta REJECTED permite corregir los datos con una clave nueva. Suspender, rotar el secreto o cambiar los permisos revoca los tokens anteriores.</p></CardContent></Card>
 {error?<ErrorState message={error}/>:!html?<Loading/>:<iframe title="Contrato OpenAPI de B2B Producción" sandbox="allow-scripts allow-same-origin" srcDoc={html} className="h-[78dvh] w-full rounded-xl border bg-white"/>}</div>;
}
