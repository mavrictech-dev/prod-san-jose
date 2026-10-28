"use client";
import { useEffect, useState } from 'react';
import { KeyRound, Mail, Save, ShieldCheck, ClipboardCheck, LoaderCircle } from 'lucide-react';
import { Button } from '@factuez/ui/components/button';
import { Badge } from '@factuez/ui/components/badge';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import { ErrorState, Loading, PageHeading } from './common';
import { useResource, useWorkspace } from './provider';
import type { Company } from './types';
import { ListPagination } from './list-pagination';
import { FiscalHelp } from './fiscal-help';
import { CorporateMail } from './corporate-mail';

type Settings = { host: string; port: 465 | 587; tlsMode: 'TLS' | 'STARTTLS'; fromName: string; fromAddress: string; replyTo: string | null };
type Status = {
  companyId: number; ruc: string; state: 'EXTERNAL_SMTP_DISABLED' | 'CORPORATE_SMTP_ACTIVE_TEST_ONLY'; revision: number; updatedAt: string | null;
  configured: boolean; credentialsConfigured: boolean; settings: Settings | null; storageReady: boolean;
  encryption: 'READY' | 'MISSING' | 'INVALID'; integrity: string; approvedHostListConfigured: boolean; hostnameApproved: boolean;
  readyToSend: false; deliveredToClient: false; connectionDiagnosticsEnabled?: boolean;
};
type Diagnostic = { state: 'EXTERNAL_SMTP_DISABLED'; locallyPrepared: boolean; checks: { code: string; status: string }[]; networkAttempted: false; readyToSend: false };
type LiveDiagnostic = { companyId: number; ruc: string; revision: number; connectionVerified: true; tlsVerified: true; smtpAuthenticationVerified: true; checkedAt: string; readyToSend: false; deliveredToClient: false };
const checkLabels: Record<string, string> = {
  STORAGE: 'Almacenamiento de Mailer', ENCRYPTION_KEY: 'Clave de cifrado', CONFIGURATION: 'Configuración guardada',
  AUTHENTICATED_ENCRYPTION: 'Integridad AES-GCM', APPROVED_HOST: 'Servidor aprobado', CREDENTIALS: 'Credenciales guardadas',
  TLS_POLICY: 'Política TLS', DNS_AND_EGRESS: 'DNS y salida de red', SMTP_AUTHENTICATION: 'Autenticación SMTP', DELIVERY: 'Entrega externa',
};
const statusLabels: Record<string, string> = {
  READY: 'Preparado', MISSING: 'Pendiente', INVALID: 'Requiere revisión', STORED: 'Guardado', VALID: 'Verificado localmente',
  NOT_CONFIGURED: 'Sin configurar', NOT_CHECKED: 'No comprobado', APPROVED: 'Aprobado por infraestructura',
  NOT_APPROVED_OR_MISSING: 'Sin servidor aprobado', MISSING_ALLOWLIST: 'Falta lista de servidores aprobados',
  MISSING_OR_NOT_VERIFIABLE: 'Sin configurar o no verificable', STRICT: 'TLS obligatorio', NOT_TESTED: 'No probado', DISABLED: 'Deshabilitada',
};
const blankSettings: Settings = { host: '', port: 587, tlsMode: 'STARTTLS', fromName: '', fromAddress: '', replyTo: null };

export function SmtpSettings() {
  const { user, catalog, companyId, can } = useWorkspace();
  const company = catalog?.companies.find(row => String(row.id) === companyId);
  if (!can('document.email') || user?.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN'))
    return <ErrorState message="La preparación SMTP requiere un administrador general con permiso de correo." />;
  return <>
    <PageHeading eyebrow="Administración" title="Correo corporativo" description="Configuración cifrada por RUC. Configuración, comprobación de conexión y autorización separada del correo de prueba por RUC." />
    <div className="mb-6 rounded-lg border bg-card p-4"><p className="text-sm font-medium">{company?.legalName ?? 'Seleccione un emisor'}</p>
      <p className="mt-1 text-xs text-muted-foreground">RUC {company?.ruc ?? '—'} · Emisor elegido en la cabecera. Cada RUC conserva su configuración independiente.</p></div>
    {company ? <SmtpForm key={`${user.sub}:${company.id}`} company={company} /> : <ErrorState message="Seleccione explícitamente un emisor en la cabecera antes de preparar el correo. Si aún no existe, créelo en Sedes y maestros." />}
  </>;
}

function SmtpForm({ company }: { company: Company }) {
  const { api, setDirty } = useWorkspace();
  const path = `/api/v1/mail-settings/${company.id}`;
  const resource = useResource<Status>(path);
  const [settings, setSettings] = useState<Settings>(blankSettings);
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [changed, setChanged] = useState(false); const [busy, setBusy] = useState(false);
  const [secureTransport, setSecureTransport] = useState(false);
  const [confirm, setConfirm] = useState(false); const [diagnostic, setDiagnostic] = useState<Diagnostic>();
  const [liveDiagnostic, setLiveDiagnostic] = useState<LiveDiagnostic>();
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false); const [auditVersion, setAuditVersion] = useState(0);
  const [error, setError] = useState<string>(); const [success, setSuccess] = useState(false);
  useEffect(() => { setDirty(changed); return () => setDirty(false); }, [changed, setDirty]);
  useEffect(() => { setSecureTransport(location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)); }, []);
  useEffect(() => { if (resource.data && !changed) setSettings(resource.data.settings ?? blankSettings); }, [resource.data, changed]);
  function update(patch: Partial<Settings>) { setSettings(current => ({ ...current, ...patch })); setChanged(true); setSuccess(false); setDiagnostic(undefined); setLiveDiagnostic(undefined); }
  function clear() { setSettings(resource.data?.settings ?? blankSettings); setUsername(''); setPassword(''); setChanged(false); setDirty(false); setError(undefined); setLiveDiagnostic(undefined); }
  async function save() {
    if (!resource.data || busy || !secureTransport) return;
    setConfirm(false); setBusy(true); setError(undefined); setSuccess(false); setDiagnostic(undefined); setLiveDiagnostic(undefined);
    try {
      const body: Record<string, unknown> = { expectedRevision: resource.data.revision, settings };
      if (username || password) {
        if (!username || !password) throw new Error('Complete usuario y contraseña para reemplazar las credenciales.');
        body.credentials = { username, password };
      }
      await api(path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      setUsername(''); setPassword(''); setChanged(false); setDirty(false); setSuccess(true); resource.reload();
      setAuditVersion(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo guardar la preparación SMTP'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!resource.data || busy || changed || !secureTransport) return;
    setBusy(true); setError(undefined);
    try {
      await api(`${path}/remove`, { method: 'POST', body: JSON.stringify({ expectedRevision: resource.data.revision }) });
      setRemoveOpen(false); setDiagnostic(undefined); clear(); resource.reload(); setAuditVersion(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo retirar SMTP'); }
    finally { setBusy(false); }
  }
  async function diagnose() {
    if (busy) return; setBusy(true); setError(undefined); setDiagnostic(undefined);
    try { setDiagnostic(await api<Diagnostic>(`${path}/dry-run`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(20000) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo comprobar la preparación local'); }
    finally { setBusy(false); }
  }
  async function verifyConnection() {
    if (!resource.data || busy || changed || !secureTransport || !resource.data.connectionDiagnosticsEnabled) return;
    const revision = resource.data.revision;
    setBusy(true); setCheckingConnection(true); setError(undefined); setLiveDiagnostic(undefined);
    try {
      const result = await api<LiveDiagnostic>(`${path}/verify-connection`, { method: 'POST',
        body: JSON.stringify({ expectedRevision: revision }), signal: AbortSignal.timeout(20000) });
      if (result.companyId !== company.id || result.ruc !== company.ruc || result.revision !== revision ||
        result.connectionVerified !== true || result.tlsVerified !== true || result.smtpAuthenticationVerified !== true ||
        result.readyToSend !== false || result.deliveredToClient !== false) throw new Error('Resultado SMTP no vigente; vuelva a consultar.');
      setLiveDiagnostic(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo verificar la conexión SMTP'); resource.reload(); }
    finally { setBusy(false); setCheckingConnection(false); }
  }
  const status = resource.data;
  return <div className="space-y-5">
    <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><ShieldCheck className="mt-0.5 size-5 shrink-0" />
      <div><p className="font-medium">Guardar y enviar son acciones separadas</p><p className="mt-1">Guardar no envía correos, no consulta DNS ni contacta SMTP. Mailpit local sigue disponible en el detalle del comprobante. No ingrese datos reales del cliente durante desarrollo.</p></div></div>
    {!secureTransport && <ErrorState message="Para ingresar secretos, abra esta pantalla con HTTPS. HTTP sólo se permite en localhost para desarrollo." />}
    <Card><CardHeader><CardTitle className="text-base">¿No tienes servidor SMTP propio?</CardTitle><CardDescription>Puedes usar un servicio de correo existente para las pruebas.</CardDescription></CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground"><p>Por ejemplo, una cuenta Gmail puede usar <strong>smtp.gmail.com</strong> con STARTTLS y puerto <strong>587</strong>. El usuario es la dirección Gmail completa y la contraseña SMTP puede ser una contraseña de aplicación de Google.</p>
        <p>Google exige verificación en dos pasos para crearla; algunas cuentas administradas no ofrecen esta opción. TI debe aprobar el servidor antes de configurarlo. Usa una cuenta de pruebas en un entorno autorizado.</p>
        <a className="inline-block text-primary underline" href="https://support.google.com/accounts/answer/185833?hl=es" target="_blank" rel="noreferrer">Cómo crear una contraseña de aplicación en Google</a>
      </CardContent></Card>
    {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !status ? <Loading /> : <>
      <div className="flex flex-wrap gap-2"><FiscalHelp title={`RUC ${status.ruc}`} description="Empresa propietaria de esta configuración de correo. No se comparten claves con otros emisores." /><FiscalHelp title={`Revisión ${status.revision}`} description="Versión de la configuración. Cambia al guardar o retirar los datos y evita sobrescribir el cambio de otro administrador." />
        <Badge variant="outline">{status.state === 'CORPORATE_SMTP_ACTIVE_TEST_ONLY' ? 'Correo de prueba autorizado' : 'Envío SMTP deshabilitado'}</Badge><Badge variant="outline">{status.configured ? 'Configuración guardada' : 'Sin configuración'}</Badge></div>
      {(!status.storageReady || status.encryption !== 'READY' || !status.approvedHostListConfigured) && <div role="status" className="rounded-lg border bg-muted/40 p-4 text-sm">
        <p className="font-medium">Preparación de infraestructura pendiente</p><p className="mt-1 text-muted-foreground">El integrador debe preparar las tablas del servicio, montar la clave de cifrado y aprobar el hostname SMTP en el servidor. Esto no activa envíos.</p>
        <p className="mt-2 text-xs">Almacenamiento: {status.storageReady ? 'preparado' : 'pendiente'} · Cifrado: {statusLabels[status.encryption]} · Lista de servidores: {status.approvedHostListConfigured ? 'configurada' : 'pendiente'}</p></div>}
      {status.integrity === 'INVALID' && <ErrorState message="No se pudo verificar la configuración cifrada. Revise la clave y su versión; no se usarán credenciales de otro RUC." />}
      <fieldset disabled={busy || !secureTransport || !status.storageReady || status.encryption !== 'READY' || !status.approvedHostListConfigured} className="grid min-w-0 gap-5 lg:grid-cols-2">
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Mail className="size-4" />Servidor y remitente</CardTitle><CardDescription>Hostname exacto aprobado por infraestructura. Sin URLs ni direcciones IP.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2"><Label htmlFor="smtp-host">Servidor SMTP</Label><Input id="smtp-host" value={settings.host} onChange={event => update({ host: event.target.value })} maxLength={253} autoComplete="off" placeholder="Hostname aprobado por infraestructura" /></div>
            <div className="space-y-2"><Label htmlFor="smtp-tls">Seguridad y puerto</Label><Select value={String(settings.port)} onValueChange={value => update(value === '465' ? { port: 465, tlsMode: 'TLS' } : { port: 587, tlsMode: 'STARTTLS' })} disabled={busy || !secureTransport || !status.storageReady || status.encryption !== 'READY' || !status.approvedHostListConfigured}>
              <SelectTrigger id="smtp-tls"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="587">STARTTLS obligatorio · 587</SelectItem><SelectItem value="465">TLS desde la conexión · 465</SelectItem></SelectContent></Select></div>
            <div className="space-y-2"><Label htmlFor="smtp-name">Nombre del remitente</Label><Input id="smtp-name" value={settings.fromName} onChange={event => update({ fromName: event.target.value })} maxLength={160} /></div>
            <div className="space-y-2"><Label htmlFor="smtp-from">Correo del remitente</Label><Input id="smtp-from" type="email" value={settings.fromAddress} onChange={event => update({ fromAddress: event.target.value })} maxLength={254} autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="smtp-reply">Responder a (opcional)</Label><Input id="smtp-reply" type="email" value={settings.replyTo ?? ''} onChange={event => update({ replyTo: event.target.value || null })} maxLength={254} autoComplete="off" /></div>
          </CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" />Credenciales cifradas</CardTitle><CardDescription>Se guardan con AES-256-GCM, vinculadas al emisor. Nunca se devuelven a esta pantalla.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><Badge variant="outline">{status.credentialsConfigured ? 'Credenciales guardadas' : 'Sin credenciales verificables localmente'}</Badge>
            <div className="space-y-2"><Label htmlFor="smtp-user">Nuevo usuario SMTP</Label><Input id="smtp-user" value={username} onChange={event => { setUsername(event.target.value); setChanged(true); setSuccess(false); setLiveDiagnostic(undefined); }} maxLength={254} autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="smtp-password">Nueva contraseña SMTP</Label><Input id="smtp-password" type="password" value={password} onChange={event => { setPassword(event.target.value); setChanged(true); setSuccess(false); setLiveDiagnostic(undefined); }} maxLength={512} autoComplete="new-password" /></div>
            <p className="text-xs text-muted-foreground">Deje ambos campos vacíos para conservar las credenciales guardadas. Complete ambos para reemplazarlas. No se guarda nada en localStorage ni se muestra el usuario anterior.</p>
            <p className="text-xs text-muted-foreground">La validación del certificado TLS será obligatoria. No se permite conexión sin cifrado ni omitir la validación del servidor.</p>
          </CardContent></Card>
      </fieldset>
      {error && <ErrorState message={error} />}
      {success && <p role="status" className="text-sm text-emerald-700">Preparación cifrada guardada. No se abrió ninguna conexión SMTP ni se enviaron mensajes.</p>}
      <div className="flex flex-wrap justify-end gap-3"><Button variant="outline" disabled={busy || !changed} onClick={clear}>Descartar campos</Button>
        {status.configured && <Button variant="outline" disabled={busy || changed || !secureTransport || !status.storageReady || status.encryption !== 'READY'} onClick={() => setRemoveOpen(true)}>Retirar configuración SMTP</Button>}
        <Button variant="outline" disabled={busy || changed} onClick={() => void diagnose()}><ClipboardCheck className="size-4" />Diagnóstico local</Button>
        <Button variant="outline" disabled={busy || changed || !secureTransport || !status.connectionDiagnosticsEnabled || !status.configured || !status.credentialsConfigured || !status.hostnameApproved || status.integrity !== 'VALID'} onClick={() => void verifyConnection()}>{checkingConnection ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}Verificar conexión SMTP</Button>
        <Button disabled={busy || !changed || !secureTransport || !status.storageReady || status.encryption !== 'READY' || !status.approvedHostListConfigured} onClick={() => setConfirm(true)}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}Guardar sin activar envío</Button></div>
      <p className="text-xs text-muted-foreground">{status.connectionDiagnosticsEnabled ? 'La comprobación contacta el servidor aprobado y valida TLS y autenticación con las credenciales guardadas. Máximo 15 segundos; no envía mensajes.' : 'La comprobación de conexión requiere habilitación explícita de infraestructura en este servidor.'} {changed && 'Guarde o descarte los cambios antes de comprobar la conexión.'}</p>
      <SmtpConnectionDiagnostic result={liveDiagnostic} revision={status.revision} changed={changed} />
      {diagnostic && <Card><CardHeader><CardTitle className="text-base">Diagnóstico sin conexión externa</CardTitle><CardDescription>{diagnostic.locallyPrepared ? 'Parámetros preparados localmente. Esto no significa SMTP operativo.' : 'Hay parámetros pendientes de preparación local.'}</CardDescription></CardHeader>
        <CardContent><dl className="grid gap-3 sm:grid-cols-2">{diagnostic.checks.map(check => <div key={check.code} className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">{checkLabels[check.code] ?? check.code}</dt><dd className="mt-1 text-sm font-medium">{statusLabels[check.status] ?? check.status}</dd></div>)}</dl>
          <p className="mt-4 text-xs text-muted-foreground">Este diagnóstico local no prueba autenticación remota, DNS, certificado del servidor ni entrega a clientes. No se enviaron correos.</p></CardContent></Card>}
    </>}
    {status && <CorporateMail key={`${path}:${status.revision}`} companyId={company.id} ruc={company.ruc} revision={status.revision} dirty={changed} secureTransport={secureTransport} parentBusy={busy} onChange={resource.reload} />}
    {status?.storageReady && <SmtpAudit key={`${path}:${auditVersion}`} path={path} />}
    <Dialog open={removeOpen} onOpenChange={value => { if (!busy) setRemoveOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Retirar correo y credenciales</DialogTitle><DialogDescription>Se retira el servidor, remitente y acceso SMTP de {company.legalName}, RUC {company.ruc}. Se conservan el historial de cambios y los correos ya registrados. No se envía ningún mensaje; volver a usar este acceso requiere configurarlo nuevamente.</DialogDescription></DialogHeader>{error && <ErrorState message={error} />}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoveOpen(false)}>Cancelar</Button><Button variant="destructive" disabled={busy || changed || !secureTransport} onClick={() => void remove()}>Confirmar retiro</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>Guardar preparación de correo</DialogTitle><DialogDescription>Se cifrará la configuración para {company.legalName}, RUC {company.ruc}. No se probará el servidor ni se enviarán mensajes.</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>Cancelar</Button><Button onClick={() => void save()}>Confirmar sin activar envío</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function SmtpAudit({ path }: { path: string }) {
  const [page, setPage] = useState(1);
  const r = useResource<{ total: number; items: { revision: number; actorId: string; credentialsReplaced: boolean; createdAt: string }[] }>(`${path}/audit?page=${page}`);
  return <Card><CardHeader><CardTitle className="text-base">Historial de correo</CardTitle><CardDescription>Auditoría de cambios del RUC seleccionado, sin direcciones de destino ni secretos.</CardDescription></CardHeader><CardContent>{r.error ? <ErrorState message={r.error} retry={r.reload} /> : !r.data ? <Loading /> : <><div className="divide-y">{r.data.items.map(item => <div key={item.revision} className="py-3 text-sm"><p>Revisión {item.revision} · {item.credentialsReplaced ? 'Acceso SMTP sustituido o retirado' : 'Parámetros actualizados'}</p><p className="mt-1 break-all text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })} · ID del responsable: {item.actorId}</p></div>)}</div><ListPagination total={r.data.total} page={page} onChange={setPage} /></>}</CardContent></Card>;
}

/** A verification belongs only to its saved revision and is invalidated by any local edit. */
export function SmtpConnectionDiagnostic({ result, revision, changed }: { result?: LiveDiagnostic; revision: number; changed: boolean }) {
  if (!result || changed || result.revision !== revision) return null;
  return <Card><CardHeader><CardTitle className="text-base">Conexión SMTP verificada</CardTitle><CardDescription>Certificado TLS y autenticación verificados para la revisión {result.revision}.</CardDescription></CardHeader><CardContent><p role="status" className="text-sm">La conexión verificada no garantiza entrega. Esta comprobación no envía mensajes ni activa el envío.</p><p className="mt-2 text-xs text-muted-foreground">Comprobado: {new Date(result.checkedAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}. Si cambia las credenciales, debe volver a comprobar.</p></CardContent></Card>;
}
