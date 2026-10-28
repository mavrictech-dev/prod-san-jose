/** Static, credential-free guide for the narrow public reference contract. */
export const connectionGuide = `
<section id="conexion" aria-labelledby="conexion-title"><h2 id="conexion-title">Antes de conectar</h2>
<p>TI debe proporcionar el origen HTTPS privado, acceso de red y certificados de transporte mTLS, además de un cliente SERVICE con scopes y grants autorizados. Esta página no comprueba conectividad ni levanta servicios.</p>
<p>El catálogo público permite consultar contratos. La API de datos requiere transporte privado y autorización vigente. Nunca introducir secretos en Swagger, navegador, URL o logs.</p>
<div class="table-scroll"><table><caption>Identificadores y credenciales de este perfil</caption><thead><tr><th>Concepto</th><th>Contrato B2B</th></tr></thead><tbody>
<tr><th>Audiencia</th><td><code>factuez-b2b-v1</code>; no acepta tokens de extracción privada ni cookies PWA.</td></tr>
<tr><th>Emisor</th><td><code>issuerId</code> es un entero positivo del catálogo autorizado, no el RUC ni un UUID.</td></tr>
<tr><th>Contexto</th><td>Ambiente <code>BETA</code>; sede, punto, serie y documento usan UUID. Los grants autorizan una tupla completa, no combinaciones de listas.</td></tr>
<tr><th>Credenciales</th><td>Cliente técnico OAuth y certificados de transporte. SOL, P12 fiscal y accesos GRE pertenecen a otros circuitos.</td></tr>
</tbody></table></div>
</section>
<section id="oauth" aria-labelledby="oauth-title"><h2 id="oauth-title">OAuth: client credentials</h2>
<ol><li>Desde el backend del consumidor, solicitar <code>POST /b2b/oauth/token</code> con mTLS y HTTP Basic: Base64 de <code>client_id:client_secret</code>. TI entrega las credenciales por un canal seguro.</li>
<li>Enviar exactamente <code>grant_type</code> y <code>scope</code> en <code>application/x-www-form-urlencoded</code>. Los scopes son únicos, separados por un espacio y previamente concedidos.</li>
<li>Usar <code>access_token</code> como Bearer. La respuesta incluye <code>token_type: Bearer</code>, <code>expires_in: 300</code> y <code>scope</code>. No hay refresh token: obtener otro al vencer.</li>
<li>Consultar <code>GET /b2b/v1/me</code> sin query y <code>GET /b2b/v1/capabilities?environment=BETA</code>. Capacidades y permisos no prueban la disponibilidad de cada propietario ni aceptación fiscal.</li></ol>
<pre aria-label="Solicitud OAuth de referencia"><code>POST /b2b/oauth/token
Authorization: Basic &lt;BASE64_CLIENT_ID_DOS_PUNTOS_CLIENT_SECRET&gt;
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&amp;scope=b2b%3Acontext%3Aread%20b2b%3Acatalog%3Aread%20b2b%3Adocuments%3Aread%20b2b%3Aartifacts%3Aread</code></pre>
<p>Las solicitudes de datos llevan <code>Authorization: Bearer &lt;ACCESS_TOKEN&gt;</code> y pueden declarar <code>X-FactuEz-Actor-Kind: SERVICE</code>. La revocación y los grants se vuelven a comprobar en servidor.</p>
<div class="table-scroll"><table><caption>Scopes mínimos según la operación</caption><thead><tr><th>Operación</th><th>Scopes</th></tr></thead><tbody>
<tr><td>Identidad y capabilities</td><td><code>b2b:context:read</code></td></tr>
<tr><td>Catálogos autorizados</td><td><code>b2b:catalog:read</code></td></tr>
<tr><td>Listado, detalle y estado</td><td><code>b2b:documents:read</code></td></tr>
<tr><td>Inventario y descarga XML/CDR o PDF actual</td><td><code>b2b:documents:read</code> + <code>b2b:artifacts:read</code></td></tr>
<tr><td>Consultar suscripciones y entregas</td><td><code>b2b:documents:read</code> + <code>b2b:webhooks:read</code></td></tr>
<tr><td>Gestionar, verificar, rotar o replay</td><td><code>b2b:documents:read</code> + <code>b2b:webhooks:manage</code></td></tr>
</tbody></table></div>
<p>Estos permisos no se conceden al abrir la documentación. El envío webhook exige también lectura de webhooks vigente. El acceso USER delegado requiere su circuito de identidad propio; este ejemplo sólo cubre SERVICE.</p>
</section>
<section id="xml-cdr" aria-labelledby="xml-title"><h2 id="xml-title">Extraer comprobantes, XML y CDR</h2>
<p>Reemplazar los marcadores con identificadores del catálogo autorizado. Ejemplos relativos al origen que indique TI; nunca usar la URL de la PWA como origen de API por suposición.</p>
<pre aria-label="Recorrido de extracción B2B"><code>GET /b2b/v1/issuers?environment=BETA&amp;limit=50
GET /b2b/v1/documents?issuerId=&lt;ISSUER_ID&gt;&amp;environment=BETA&amp;from=2026-10-01&amp;to=2026-10-28&amp;types=01,03&amp;limit=50
GET /b2b/v1/documents/&lt;DOCUMENT_UUID&gt;?issuerId=&lt;ISSUER_ID&gt;&amp;environment=BETA
GET /b2b/v1/documents/&lt;DOCUMENT_UUID&gt;/artifacts?issuerId=&lt;ISSUER_ID&gt;&amp;environment=BETA
GET /b2b/v1/artifacts/&lt;ARTIFACT_UUID&gt;/content?issuerId=&lt;ISSUER_ID&gt;&amp;environment=BETA</code></pre>
<ol><li>Listar emisores y elegir su <code>id</code>. El perfil de lectura documentado cubre <code>01</code> y <code>03</code> en BETA. <code>07/08/09/31</code> son <code>SOURCE_NOT_SUPPORTED</code> para este perfil; no inferir cobertura por otros contratos candidatos.</li>
<li>Listar documentos con fechas inclusivas, máximo 366 días. Tamaño por defecto 50, máximo 100. Repetir los mismos filtros y tamaño con <code>page.nextCursor</code> hasta <code>page.hasMore: false</code>. Corte de hasta 10.000 filas y 300 segundos; ante expiración iniciar otro corte según el error. <code>page.complete</code> no acredita cobertura universal.</li>
<li>Consultar detalle para cliente, ítems, impuestos y totales disponibles. Los importes y cantidades son texto decimal; <code>null</code> no es cero. Conservar el XML completo para su estructura UBL original.</li>
<li>Inventariar archivos y elegir por <code>kind</code>: <code>UNSIGNED_XML</code>, <code>SIGNED_XML</code>, <code>SUBMISSION_ZIP</code>, <code>CDR_XML</code> o <code>CDR_ZIP</code>. Este inventario devuelve originales existentes <code>AVAILABLE</code>; no promete un CDR por documento ni reemplaza faltantes por archivos simulados.</li>
<li>Descargar con el ID del archivo, no el del documento ni una ruta de disco. Guardar los bytes XML/ZIP sin reescribirlos; contrastar tamaño y SHA-256 con inventario y <code>X-Content-SHA256</code>.</li></ol>
<p>Si <code>owner.kind</code> es <code>BATCH</code>, el archivo corresponde a un lote: <code>GET /b2b/v1/batches/{id}/artifacts</code> exige el mismo emisor y ambiente y autorización sobre todos sus miembros. No se fabrica un CDR individual de resumen.</p>
<p><code>GET /b2b/v1/documents/{id}/representations/{format}</code>, con <code>format=a4</code> o <code>ticket</code>, devuelve una representación PDF local actual, separada del original XML/CDR. Integridad SHA-256 no acredita firma, confianza ni aceptación SUNAT. La extracción lee archivos conservados; no consulta SUNAT en cada descarga.</p>
</section>
<section id="webhooks" aria-labelledby="hooks-title"><h2 id="hooks-title">Webhooks: emisión local</h2>
<p>Este contrato cubre sólo <code>document.issued-locally.v1</code> para 01/03 locales BETA. No anuncia eventos de aceptación/rechazo SUNAT, XML/CDR, notas o guías por figurar en un catálogo de diseño más amplio.</p>
<ol><li>TI aprueba un <code>destinationId</code> para el receptor HTTPS. El alta no acepta una URL libre. Cada suscripción pertenece al cliente/actor y a una tupla autorizada.</li>
<li>Crear con <code>POST /b2b/v1/webhook-subscriptions?issuerId=&lt;ISSUER_ID&gt;&amp;environment=BETA</code>, JSON y <code>Idempotency-Key</code> de 16 a 100 caracteres <code>A-Z a-z 0-9 _ -</code>. El secreto de firma sólo se muestra al crear o rotar; no se recupera mediante GET ni replay.</li>
<li>Verificar con <code>POST /b2b/v1/webhook-subscriptions/{id}/verify</code>, query de emisor/ambiente y cuerpo <code>{}</code>. El receptor debe responder HTTP 200 con JSON exacto <code>{"challenge":"&lt;NONCE_RECIBIDO&gt;"}</code>. No enviar a destinos sin verificar.</li>
<li>Las mutaciones de recurso, verificación, rotación y replay necesitan <code>If-Match</code> con la revisión de la <strong>suscripción</strong>, incluso al repetir una entrega. 412 indica revisión distinta; 428, ausente. No usar la revisión de la entrega.</li></ol>
<pre aria-label="Cuerpo de alta de suscripción con marcadores"><code>{
  "binding": {
    "issuerId": &lt;ISSUER_ID&gt;,
    "issuerRuc": "&lt;RUC_AUTORIZADO&gt;",
    "documentType": "01",
    "branchId": "&lt;BRANCH_UUID&gt;",
    "pointId": "&lt;POINT_UUID&gt;",
    "seriesId": "&lt;SERIES_UUID&gt;",
    "environment": "BETA"
  },
  "label": "Emisión local del ERP",
  "destinationId": "&lt;DESTINO_APROBADO&gt;",
  "events": ["document.issued-locally.v1"]
}</code></pre>
<p>Es una plantilla con marcadores, no JSON listo para enviar. Sustituir el emisor por un número y los UUID/destino por valores autorizados. <code>binding</code> usa el esquema <code>Context</code> del contrato de suscripciones.</p>
<h3>Verificar y confirmar la recepción</h3>
<p>Comprobar Standard Webhooks con el secreto de firma y los bytes UTF-8 exactos antes de parsearlos. Cabeceras: <code>webhook-id</code> (= deliveryId), <code>webhook-timestamp</code> (segundos) y <code>webhook-signature</code> (v1). HMAC-SHA256 sobre <code>id + "." + timestamp + "." + cuerpo_original</code>; tolerancia 300 segundos. No reserializar JSON para verificar.</p>
<p>El payload contiene referencias mínimas, versión/hash y procedencia LOCAL; no incluye XML/CDR, cliente/ítems, tokens ni enlaces públicos. Consultar los recursos por API con permisos vigentes. Guardar en una Inbox durable y deduplicar por deliveryId/eventId antes de confirmar 2xx; coordinar el efecto de negocio en la transacción del consumidor.</p>
<p>Entrega al menos una vez, sin orden global. Hasta ocho intentos por ronda; puede haber duplicados. En rotación hay una ventana de cinco minutos con ambas firmas. Un 2xx confirma recepción, no aceptación tributaria.</p>
<h3>Consultar fallos y replay</h3>
<p>Consultar <code>GET /b2b/v1/webhook-deliveries</code> y <code>GET /b2b/v1/webhook-deliveries/{id}</code> con emisor/ambiente. Los listados usan <code>after</code>, <code>page.nextCursor</code> y <code>page.hasMore</code>. Replay: <code>POST /b2b/v1/webhook-deliveries/{id}/replay</code>, cuerpo <code>{}</code>, Idempotency-Key e If-Match de suscripción. Sólo desde DEAD_LETTER/CANCELLED, máximo cinco replays; conserva eventId/deliveryId. El 202 sólo reprograma. No hay backfill automático al crear una suscripción.</p>
</section>
<section id="errores" aria-labelledby="errors-title"><h2 id="errors-title">Errores y disponibilidad</h2>
<p>Usar el código y <code>retryable</code> de la respuesta B2B. OAuth devuelve <code>{"error":"..."}</code>, sin la envoltura B2B. 401: revisar credencial o vencimiento; 403/404: revisar autorización sin explorar IDs ajenos; 409/410: conflicto o corte expirado; 412/428: revisión; 422: perfil no soportado; 429/503: reintento acotado respetando Retry-After cuando exista.</p>
<p>Registrar correlación y resultado, sin secretos ni XML completos. La documentación no sondea servicios: <code>NOT_PROBED_BY_DOCUMENTATION</code>. Una respuesta sintética o una prueba unitaria no acredita despliegue, piloto remoto ni disponibilidad operativa.</p>
</section>`;
