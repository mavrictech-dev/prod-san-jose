"use client";
import {useMemo} from 'react';
import {useResource,useWorkspace} from '../workspace/provider';
import {ErrorState,Loading,PageHeading} from '../workspace/common';
import {Button} from '@factuez/ui/components/button';
export function privateSwaggerDocument(spec:unknown,nonce:string){
 if(!/^[a-zA-Z0-9-]{16,80}$/.test(nonce))throw Error('Nonce inválido');
 const json=JSON.stringify(spec).replace(/</g,'\\u003c');
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><link rel="stylesheet" href="/api-docs/assets/swagger-ui.css"></head><body><div id="swagger-ui"></div><script nonce="${nonce}" src="/api-docs/assets/swagger-ui-bundle.js"></script><script nonce="${nonce}">SwaggerUIBundle({spec:${json},dom_id:'#swagger-ui',supportedSubmitMethods:[],tryItOutEnabled:false,persistAuthorization:false,queryConfigEnabled:false,validatorUrl:null,requestInterceptor:function(){throw new Error('Visor de sólo lectura')},plugins:[function(){return{components:{authorizeBtn:function(){return null},AuthorizeBtn:function(){return null}}}}]});</script></body></html>`;
}
function AuthorizedViewer(){
 const resource=useResource<Record<string,unknown>>('/api/v1/setup/sunat/reference');
 const html=useMemo(()=>resource.data?privateSwaggerDocument(resource.data,crypto.randomUUID()):undefined,[resource.data]);
 return <><PageHeading eyebrow="API PRIVADA" title="API de FactuEz" description="Sesión, emisión, consultas, maestros, formatos, XML/CDR y correo. Acceso según los permisos de cada operación; OAuth de aplicaciones se documenta en el catálogo B2B."/>
  <div className="mb-4 flex flex-wrap gap-2"><Button variant="outline" onClick={resource.reload}>Actualizar documentación</Button><Button variant="outline" asChild><a href="/api-docs" target="_blank" rel="noopener noreferrer">Documentación B2B</a></Button></div>
  {resource.error?<ErrorState message={resource.error} retry={resource.reload}/>:!html?<Loading/>:<iframe title="Swagger de la API nativa de FactuEz" sandbox="allow-scripts allow-same-origin" srcDoc={html} className="h-[75dvh] w-full rounded-xl border bg-white"/>}</>;
}
export function PrivateApiViewer(){
 const {user,can}=useWorkspace();
 if(user?.scope.kind!=='GLOBAL'||!user.roles.includes('ADMIN')||!can('sunat.configure'))return <ErrorState message="La referencia fiscal requiere administrador general y permiso SUNAT."/>;
 return <AuthorizedViewer/>;
}
