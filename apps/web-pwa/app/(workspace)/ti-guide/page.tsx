"use client";
import Link from 'next/link';
import {FileDown,ArrowRight,ShieldCheck} from 'lucide-react';
import {Badge} from '@factuez/ui/components/badge';
import {Button} from '@factuez/ui/components/button';
import {Card,CardContent,CardHeader,CardTitle} from '@factuez/ui/components/card';
import {useWorkspace} from '../../../features/workspace/provider';

const steps=[
 {title:'1. Empresas, sedes y series',href:'/stations',action:'Abrir sedes y maestros',body:'Registra cada empresa con su RUC y datos confirmados. Asocia sus sedes, puntos de emisión y series. Cada RUC se configura por separado. No cambies correlativos ni propietarios de series históricas sin conciliación y aprobación.'},
 {title:'2. Certificado y credenciales SUNAT',href:'/sunat-settings',action:'Abrir configuración SUNAT',body:'Selecciona el emisor en la cabecera y Beta / pruebas. Carga su certificado .p12 o .pfx y contraseña; configura el usuario secundario SOL y, si corresponde, las credenciales GRE. Ingresa los secretos directamente en la pantalla del emisor; no los envíes por chat. Guardar no acredita confianza, autenticación ni habilita la emisión.'},
 {title:'3. Recepción de compras',href:'/received',action:'Abrir documentos recibidos',body:'Prepara SIRE e IMAP por cada RUC con los accesos autorizados. SIRE permite descubrir comprobantes; el XML completo depende de su disponibilidad o de que el proveedor lo entregue. La recepción externa requiere configuración y pruebas adicionales.'},
 {title:'4. Correo saliente',href:'/mail-settings',action:'Abrir correo corporativo',body:'Prepara SMTP por RUC y revisa sus indicadores de almacenamiento, cifrado, servidor y credenciales. El envío externo permanece pendiente de habilitación y pruebas; una configuración guardada no confirma conexión o entrega.'},
 {title:'5. Acceso de otras aplicaciones',href:'/integrations',action:'Abrir integraciones B2B',body:'Usa la sesión administrativa autorizada para configurar las aplicaciones, sus permisos y el alcance por empresa, sede y serie. La conectividad privada, las identidades y el piloto requieren preparación y validación de infraestructura.'},
 {title:'6. Historial y puesta en marcha',href:'/integrations',action:'Revisar preparación',body:'TI debe coordinar una copia autorizada del historial, XML y CDR, el mapa de series y la conciliación con Contabilidad. Antes de instalar en el VPS, revisen el Docker Compose y preparen respaldo, restauración, acceso privado y HTTPS. La emisión oficial y el corte requieren validación y aprobación independientes.'},
] as const;
export default function TiGuidePage(){
 const {user,can}=useWorkspace();
 if(!user||user.scope.kind!=='GLOBAL'||!user.roles.includes('ADMIN')||!['setup.manage','user.manage','role.manage'].every(can))return <p role="alert">Esta sección requiere un administrador general autorizado.</p>;
 return <section className="ti-guide-print mx-auto w-full max-w-5xl space-y-6" aria-labelledby="ti-guide-title">
  <header className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-4"><Badge variant="outline">Guía de configuración · Beta</Badge><Button className="ti-guide-no-print" onClick={()=>window.print()}><FileDown/>Guardar como PDF / Imprimir</Button></div>
   <div><p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">FactuEz · Estaciones San José</p><h1 id="ti-guide-title" className="mt-2 text-3xl font-semibold tracking-tight">Guía para el responsable de TI</h1><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Pasos para preparar cada emisor y coordinar la configuración con Administración y Contabilidad.</p></div>
   <p className="ti-guide-no-print text-xs text-muted-foreground">Para obtener el archivo, selecciona «Guardar como PDF» como destino en la ventana de impresión.</p>
  </header>
  <div className="ti-guide-section rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 print:border-gray-300 print:bg-white print:text-black"><p className="font-semibold">Estado actual: Beta / pruebas</p><p className="mt-1">Esta guía ayuda a preparar la configuración. El envío oficial a SUNAT, el correo externo y el despliegue definitivo requieren completar las validaciones pendientes; guardar credenciales no los activa.</p></div>
  <div className="grid gap-4 md:grid-cols-2 print:block">{steps.map(step=><Card key={step.title} className="ti-guide-section shadow-none print:mb-3 print:rounded-none"><CardHeader className="pb-2"><CardTitle className="text-base">{step.title}</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm leading-6 print:text-black">{step.body}</p><Button variant="outline" size="sm" asChild className="ti-guide-no-print"><Link href={step.href}>{step.action}<ArrowRight/></Link></Button></CardContent></Card>)}</div>
  <div className="ti-guide-section flex items-start gap-3 rounded-lg border p-4 text-sm"><ShieldCheck className="ti-guide-no-print mt-0.5 size-4 shrink-0"/><p>Usa HTTPS fuera de localhost y configura secretos únicamente en un entorno autorizado. El certificado, las claves de cifrado, los respaldos y la infraestructura son responsabilidad de TI; no cargues datos reales en el entorno de demostración.</p></div>
 </section>;
}
