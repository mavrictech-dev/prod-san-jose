"use client";

import Link from 'next/link';
import { useId, useState } from 'react';
import { ArrowRight, Building2, FileKey2, Inbox, Mail, ShieldCheck } from 'lucide-react';
import { Badge } from '@factuez/ui/components/badge';
import { Button } from '@factuez/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { useResource, useWorkspace } from '../workspace/provider';
import type { Company } from '../workspace/types';

type CredentialEnvironment = 'BETA' | 'PRODUCTION';
type FiscalStatus = { ruc:string; environment:string; certificate:{configured:boolean;expired:boolean}; solConfigured:boolean; greConfigured:boolean };

/** Only metadata for the currently selected issuer and explicit environment. The server remains
 * responsible for permissions; a saved secret is not proof of a working service. */
export function IssuerCredentialSummary({company,environment}:{company:Company;environment:CredentialEnvironment}) {
 const status=useResource<FiscalStatus>(`/api/v1/setup/sunat/${company.id}/${environment}`);
 if(status.error)return <p className="text-xs text-muted-foreground">Estado de credenciales no disponible.</p>;
 if(!status.data)return <p role="status" className="text-xs text-muted-foreground">Consultando credenciales de {environment}…</p>;
 if(status.data.ruc!==company.ruc || status.data.environment!==environment || !status.data.certificate || typeof status.data.certificate.configured!=='boolean' || typeof status.data.certificate.expired!=='boolean' || typeof status.data.solConfigured!=='boolean' || typeof status.data.greConfigured!=='boolean')return <p role="alert" className="text-xs text-destructive">No se pudo confirmar el emisor de esta configuración.</p>;
 const {certificate,solConfigured,greConfigured}=status.data;
 return <div className="flex flex-wrap gap-2" aria-label={`Estado de credenciales ${environment}`}>
  <Badge variant="outline">Certificado: {certificate.configured ? certificate.expired ? 'vencido' : 'guardado' : 'pendiente'}</Badge>
  <Badge variant="outline">SOL: {solConfigured ? 'guardado' : 'pendiente'}</Badge>
  <Badge variant="outline">GRE: {greConfigured ? 'guardado' : 'pendiente'}</Badge>
 </div>;
}

type SmtpStatus = { companyId: number; ruc: string; state: string; storageReady: boolean; encryption: string; approvedHostListConfigured: boolean; hostnameApproved: boolean; configured: boolean; credentialsConfigured: boolean; integrity: string; readyToSend: boolean };

/** Read only the status for this issuer; never render settings or server errors. */
function SmtpSummary({company}:{company:Company}) {
 const status=useResource<SmtpStatus>(`/api/v1/mail-settings/${company.id}`);
 if(status.error)return <p role="status" className="text-xs text-muted-foreground">Estado SMTP no disponible. Abre correo corporativo para revisarlo.</p>;
 if(!status.data)return <p role="status" className="text-xs text-muted-foreground">Consultando preparación SMTP…</p>;
 const s=status.data;
 if(s.companyId!==company.id || s.ruc!==company.ruc || s.state!=='EXTERNAL_SMTP_DISABLED' || s.readyToSend!==false ||
  !['storageReady','approvedHostListConfigured','hostnameApproved','configured','credentialsConfigured'].every(key=>typeof s[key as keyof SmtpStatus]==='boolean') ||
  !['READY','MISSING','INVALID'].includes(s.encryption) || !['NOT_CONFIGURED','NOT_CHECKED','VALID','INVALID'].includes(s.integrity))
  return <p role="alert" className="text-xs text-destructive">No se pudo confirmar el estado SMTP de este emisor.</p>;
 const pending=[!s.storageReady && 'Almacenamiento pendiente',s.encryption!=='READY' && 'Cifrado pendiente o inválido',
  !s.approvedHostListConfigured && 'Lista de servidores aprobados pendiente',!s.configured && 'Configuración SMTP pendiente',
  s.configured && !s.hostnameApproved && 'Servidor guardado sin aprobación',!s.credentialsConfigured && 'Credenciales pendientes',
  s.integrity==='INVALID' && 'Integridad de la configuración requiere revisión',
  s.integrity==='NOT_CHECKED' && 'Integridad de la configuración sin comprobar'].filter(Boolean);
 return <div className="space-y-2" aria-label="Pendientes SMTP"><p className="text-xs font-medium">Preparación SMTP</p>
  {pending.length ? <ul className="list-inside list-disc text-xs text-muted-foreground">{pending.map(item=><li key={String(item)}>{item}</li>)}</ul> :
   <p className="text-xs text-muted-foreground">Sin pendientes en los indicadores consultados.</p>}
  <p className="text-xs text-muted-foreground">Envío externo deshabilitado; estos indicadores no prueban la conexión ni la entrega.</p></div>;
}

export function ConfigurationOverview(){
 const {catalog,companyId,can}=useWorkspace();
 const company=catalog?.companies.find(row=>String(row.id)===companyId);
 const [environment,setEnvironment]=useState<CredentialEnvironment>(company?.environment==='PRODUCTION' ? 'PRODUCTION' : 'BETA');
 const environmentId=useId();
 const branches=company ? catalog?.branches.filter(row=>row.companyId===company.id) ?? [] : [];
 const points=company ? catalog?.emissionPoints.filter(row=>row.companyId===company.id) ?? [] : [];
 return <section aria-labelledby="ti-setup-title" className="space-y-4">
  <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle id="ti-setup-title">Servicios por emisor</CardTitle>
   <CardDescription>RUC, credenciales, recepción y correo.</CardDescription></div><Badge variant="outline">{environment==='BETA' ? 'BETA · Pruebas' : 'PRODUCTION · Producción'}</Badge></div></CardHeader>
   <CardContent className="space-y-3"><p className="text-sm font-medium">{company ? `${company.legalName} · RUC ${company.ruc}` : 'Selecciona un emisor en la cabecera'}</p>
    <p className="text-sm text-muted-foreground">{company ? `${branches.length} ${branches.length===1?'sede':'sedes'} y ${points.length} ${points.length===1?'punto':'puntos'} visibles para este emisor.` : 'Selecciona un emisor para consultar su configuración.'}</p>
    <div className="max-w-sm space-y-2"><label htmlFor={environmentId} className="text-sm font-medium">Ambiente de credenciales SUNAT</label>
     <select id={environmentId} value={environment} onChange={event=>setEnvironment(event.target.value as CredentialEnvironment)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <option value="BETA">BETA · Pruebas</option><option value="PRODUCTION">PRODUCTION · Producción</option>
     </select></div>
    <p className="text-xs text-muted-foreground">Ingresa secretos desde HTTPS, con una cuenta autorizada. No compartas credenciales. Guardarlos no activa el envío fiscal ni verifica la conexión con SUNAT o el correo.</p>
   </CardContent></Card>
  <div className="grid gap-4 md:grid-cols-2">
   <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4"/>Emisores (RUC) y sedes</CardTitle><CardDescription>RUC, sedes, puntos y series.</CardDescription></CardHeader>
    <CardContent><Button variant="outline" asChild><Link href="/stations">Gestionar RUC y sedes <ArrowRight /></Link></Button></CardContent></Card>
   <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileKey2 className="size-4"/>Credenciales SUNAT</CardTitle><CardDescription>Certificado .p12/.pfx, SOL y GRE del emisor.</CardDescription></CardHeader>
    <CardContent className="space-y-4">{company && can('sunat.configure') && <IssuerCredentialSummary key={`${company.id}:${environment}`} company={company} environment={environment}/>}<p className="text-xs text-muted-foreground">Un estado guardado no acredita confianza, autenticación ni habilitación fiscal.</p>
     {can('sunat.configure') ? <Button variant="outline" asChild><Link href="/sunat-settings">Cargar credenciales <ArrowRight /></Link></Button> : <p className="text-xs text-muted-foreground">Requiere permiso de configuración SUNAT.</p>}</CardContent></Card>
   <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Inbox className="size-4"/>Compras y recepción</CardTitle><CardDescription>Prepara SIRE y el buzón IMAP en Documentos recibidos para el RUC elegido.</CardDescription></CardHeader>
    <CardContent className="space-y-4"><p className="text-xs text-muted-foreground">SIRE permite descubrir comprobantes; el XML completo depende de su disponibilidad.</p>
     {can('report.view') ? <Button variant="outline" asChild><Link href="/received">Abrir documentos recibidos <ArrowRight /></Link></Button> : <p className="text-xs text-muted-foreground">Requiere permiso para consultar documentos recibidos.</p>}</CardContent></Card>
   <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Mail className="size-4"/>Correo saliente</CardTitle><CardDescription>Prepara el servidor SMTP y las credenciales cifradas de cada RUC.</CardDescription></CardHeader>
    <CardContent className="space-y-4">{company && can('document.email') && <SmtpSummary key={company.id} company={company}/>}<p className="text-xs text-muted-foreground">El envío externo está pendiente de habilitación y pruebas.</p>
     {can('document.email') ? <Button variant="outline" asChild><Link href="/mail-settings">Abrir correo corporativo <ArrowRight /></Link></Button> : <p className="text-xs text-muted-foreground">Requiere permiso de correo.</p>}</CardContent></Card>
  </div>
  <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4 shrink-0"/>La administración B2B de aplicaciones y permisos se encuentra en el panel de esta página y requiere su propia sesión autorizada.</p>
 </section>;
}
