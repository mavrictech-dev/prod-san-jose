"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Badge } from '@factuez/ui/components/badge';
import { Button } from '@factuez/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@factuez/ui/components/table';
import { Plus, RefreshCw } from 'lucide-react';
import {
  IntegrationAdminController, integrationAdminInputError, integrationAdminScopes,
  type B2bBinding, type IntegrationAdminClient, type IntegrationAdminCommand,
  type IntegrationAdminCreate, type IntegrationAdminPort,
} from './integration-admin-model';

export type { IntegrationAdminPort, IntegrationAdminClient, IntegrationAdminCreate, IntegrationAdminUpdate, IntegrationAdminPage } from './integration-admin-model';

const selectClass = 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const alertClass = 'rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive';
type BindingDraft = { issuerId: string; issuerRuc: string; branchId: string; pointId: string; seriesId: string; documentType: '' | '01' | '03' };
const blankBinding = (): BindingDraft => ({ issuerId: '', issuerRuc: '', branchId: '', pointId: '', seriesId: '', documentType: '' });

/** Deliberately renders no working controls when the host has no session port. */
export function IntegrationAdminPanel({ port }: { port?: IntegrationAdminPort | null }) {
  if (!port || !['list', 'read', 'create', 'update', 'rotate'].every(method => typeof port[method as keyof IntegrationAdminPort] === 'function')) {
    return <section aria-label="Administración de integraciones"><h2 className="text-xl font-semibold tracking-tight">Integraciones B2B</h2><p role="alert" className={`${alertClass} mt-4`}>Error de configuración: no hay una conexión de administración vinculada a la sesión. Contacta al administrador.</p></section>;
  }
  return <ConnectedIntegrationAdminPanel port={port} />;
}

type Modal = { owner: IntegrationAdminController } & (
  | { kind: 'create' }
  | { kind: 'edit'; client: IntegrationAdminClient }
  | { kind: 'confirm'; command: IntegrationAdminCommand; label: string }
  | { kind: 'secret'; value: string }
);

function ConnectedIntegrationAdminPanel({ port }: { port: IntegrationAdminPort }) {
  const controller = useMemo(() => new IntegrationAdminController(port), [port]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [storedModal, setModal] = useState<Modal | null>(null);
  const modal = storedModal?.owner === controller ? storedModal : null;
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const sectionFocus = useRef<HTMLElement | null>(null);
  const dialogFocus = useRef<HTMLButtonElement | null>(null);
  const fallbackFocus = useRef<HTMLButtonElement | null>(null);
  const secretId = useId();
  useEffect(() => {
    setModal(null);
    controller.start();
    return () => { controller.dispose(); };
  }, [controller]);
  useEffect(() => { dialogFocus.current?.focus(); }, [modal?.kind]);
  function close() { controller.cancelReveal(); setModal(null); }
  function open(value: Modal, trigger: HTMLButtonElement) {
    controller.cancelReveal(); returnFocus.current = trigger; setModal(value);
  }
  function prepare(input: IntegrationAdminCreate) {
    if (!modal || (modal.kind !== 'create' && modal.kind !== 'edit')) return;
    const command: IntegrationAdminCommand = modal.kind === 'create' ? { action: 'create', input } : {
      action: 'update', id: modal.client.id, input: { expectedRevision: modal.client.revision, scopes: input.scopes, bindings: input.bindings },
    };
    setModal({ owner: controller, kind: 'confirm', command, label: input.label });
  }
  function confirm() {
    if (modal?.kind !== 'confirm') return;
    void controller.confirm(modal.command,
      value => setModal({ owner: controller, kind: 'secret', value }),
      () => setModal(null));
  }
  const selected = state.selected;
  return <section ref={sectionFocus} tabIndex={-1} aria-label="Administración de integraciones" className="space-y-5 focus:outline-none" aria-busy={state.loading}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-xl font-semibold tracking-tight">Integraciones B2B</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Administra accesos de servicio y usuario, sus permisos y su alcance por emisor.</p></div>
      <div className="flex flex-wrap gap-2">
        <Button ref={fallbackFocus} variant="outline" disabled={state.loading || !!modal} onClick={() => void controller.load()}><RefreshCw aria-hidden="true" className="mr-2 size-4" />Actualizar</Button>
        <Button disabled={state.loading || !state.loaded || !!modal} onClick={event => open({ owner: controller, kind: 'create' }, event.currentTarget)}><Plus aria-hidden="true" className="mr-2 size-4" />Nueva integración</Button>
      </div>
    </div>
    <p className="text-sm text-muted-foreground">La autorización y la verificación adicional de identidad se comprueban en el servidor en cada operación.</p>
    {state.error && <p role="alert" className={alertClass}>{state.error}</p>}
    <div role="status" aria-live="polite" className="text-sm text-muted-foreground">{state.loading ? 'Consultando integraciones…' : state.notice}</div>
    <Card>
      <CardHeader><CardTitle>Accesos registrados</CardTitle><CardDescription>Permisos y alcances autorizados en BETA. Un acceso habilitado no confirma la conexión de la aplicación.</CardDescription></CardHeader>
      <CardContent>
        <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Integración</TableHead><TableHead>Tipo</TableHead><TableHead>Estado</TableHead><TableHead>Revisión</TableHead><TableHead className="text-right">Detalle</TableHead></TableRow></TableHeader><TableBody>
          {!state.items.length && <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">{state.loading ? 'Cargando accesos…' : state.loaded ? 'No hay integraciones registradas en tu alcance.' : 'Actualiza para consultar las integraciones.'}</TableCell></TableRow>}
          {state.items.map(client => <TableRow key={client.id} aria-selected={selected?.id === client.id}>
            <TableCell><p className="max-w-64 break-words font-medium">{client.label}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{client.id}</p></TableCell>
            <TableCell>{client.kind === 'SERVICE' ? 'Servicio' : 'Usuario'}</TableCell><TableCell><Badge variant="outline">{client.enabled ? 'Acceso habilitado' : 'Acceso deshabilitado'}</Badge></TableCell><TableCell>{client.revision}</TableCell>
            <TableCell className="text-right"><Button size="sm" variant="outline" disabled={state.loading || !!modal} onClick={() => void controller.inspect(client.id)} aria-label={`Ver detalle de ${client.label}`}>Ver detalle</Button></TableCell>
          </TableRow>)}
        </TableBody></Table></div>
        {state.hasMore && <Button variant="outline" className="mt-4" disabled={state.loading || !!modal} onClick={() => void controller.load(true)}>Cargar más</Button>}
      </CardContent>
    </Card>
    {selected && <Card>
      <CardHeader><CardTitle className="break-words">{selected.label}</CardTitle><CardDescription>Revisión {selected.revision}. Los cambios se envían con esta revisión para evitar sobrescrituras.</CardDescription></CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Tipo de acceso</dt><dd>{selected.kind === 'SERVICE' ? 'Servicio' : 'Usuario con OIDC'}</dd></div><div><dt className="text-muted-foreground">Estado</dt><dd>{selected.enabled ? 'Acceso habilitado' : 'Acceso deshabilitado'}</dd></div>{selected.kind === 'USER' && <div className="sm:col-span-2"><dt className="text-muted-foreground">Cliente OIDC</dt><dd className="break-all font-mono">{selected.oidcClientId}</dd></div>}</dl>
        <div><h3 className="mb-2 text-sm font-semibold">Permisos asignados</h3><ul className="grid gap-1 text-sm sm:grid-cols-2">{selected.scopes.map(scope => <li className="break-all font-mono text-xs" key={scope}>{scope}</li>)}</ul></div>
        <IntegrationAdminBindings bindings={selected.bindings} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={state.loading || !!modal} onClick={event => open({ owner: controller, kind: 'edit', client: selected }, event.currentTarget)}>Editar permisos y alcances</Button>
          <Button variant={selected.enabled ? 'outline' : 'default'} disabled={state.loading || !!modal} onClick={event => open({ owner: controller, kind: 'confirm', label: selected.label, command: { action: 'update', id: selected.id, input: { expectedRevision: selected.revision, enabled: !selected.enabled } } }, event.currentTarget)}>{selected.enabled ? 'Desactivar' : 'Activar'}</Button>
          {selected.kind === 'SERVICE' && <Button variant="outline" disabled={state.loading || !!modal} onClick={event => open({ owner: controller, kind: 'confirm', label: selected.label, command: { action: 'rotate', id: selected.id, input: { expectedRevision: selected.revision } } }, event.currentTarget)}>Rotar secreto</Button>}
        </div>
      </CardContent>
    </Card>}
    <Dialog open={!!modal} onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={event => { event.preventDefault(); const target = returnFocus.current; if (target?.isConnected && !target.disabled) target.focus(); else if (fallbackFocus.current && !fallbackFocus.current.disabled) fallbackFocus.current.focus(); else sectionFocus.current?.focus(); }}>
        {modal?.kind === 'create' || modal?.kind === 'edit' ? <>
          <DialogHeader><DialogTitle>{modal.kind === 'create' ? 'Nueva integración' : 'Editar permisos y alcances'}</DialogTitle><DialogDescription>Elige los permisos mínimos y cada combinación autorizada. El servidor valida el catálogo y tu autorización vigente.</DialogDescription></DialogHeader>
          <IntegrationAdminEditor key={modal.kind === 'edit' ? modal.client.id : 'new'} client={modal.kind === 'edit' ? modal.client : undefined} onPrepare={prepare} onCancel={close} />
        </> : modal?.kind === 'confirm' ? <>
          <DialogHeader><DialogTitle>Confirmar {modal.command.action === 'create' ? 'alta de integración' : modal.command.action === 'rotate' ? 'rotación de secreto' : 'cambio de integración'}</DialogTitle><DialogDescription>{modal.label}. {modal.command.action === 'rotate' ? 'El secreto anterior dejará de funcionar. El nuevo se mostrará una sola vez.' : modal.command.action === 'create' ? 'Al confirmar se registrará el acceso. Si es de servicio, su secreto se mostrará una sola vez.' : 'Se actualizará el acceso usando la revisión que acabas de consultar.'}</DialogDescription></DialogHeader>
          {modal.command.action !== 'create' && <p className="text-sm">Revisión esperada: {modal.command.input.expectedRevision}</p>}
          {modal.command.action === 'create' && <p className="text-sm">{modal.command.input.scopes.length} permisos y {modal.command.input.bindings.length} alcances seleccionados.</p>}
          <p role="status" className="text-sm text-muted-foreground">{state.loading ? 'Solicitud enviada. Si cierras, se ocultará cualquier secreto recibido; el cambio puede completarse y se consultará la revisión actual.' : 'Confirma sólo cuando estés listo para aplicar el cambio y guardar el secreto de forma segura, si corresponde.'}</p>
          <DialogFooter><Button ref={dialogFocus} variant="outline" onClick={close}>{state.loading ? 'Cerrar y ocultar resultado' : 'Cancelar'}</Button><Button disabled={state.loading} onClick={confirm}>{state.loading ? 'Procesando…' : 'Confirmar operación'}</Button></DialogFooter>
        </> : modal?.kind === 'secret' ? <>
          <DialogHeader><DialogTitle>Guarda el secreto ahora</DialogTitle><DialogDescription>Se muestra una sola vez. Al cerrar se ocultará y no podrás recuperarlo desde este panel. Selecciónalo manualmente para guardarlo en un lugar seguro.</DialogDescription></DialogHeader>
          <Label htmlFor={secretId}>Secreto de la integración</Label><Input id={secretId} readOnly value={modal.value} autoComplete="off" spellCheck={false} className="font-mono" />
          <DialogFooter><Button ref={dialogFocus} onClick={close}>Cerrar y ocultar secreto</Button></DialogFooter>
        </> : null}
      </DialogContent>
    </Dialog>
  </section>;
}

export function IntegrationAdminBindings({ bindings }: { bindings: B2bBinding[] }) {
  return <div><h3 className="mb-2 text-sm font-semibold">Alcance por RUC, sede, punto y serie</h3><div className="space-y-3">{bindings.map((binding, index) => <dl key={`${binding.seriesId}-${index}`} className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-2">
    <div><dt className="text-muted-foreground">RUC / emisor</dt><dd>{binding.issuerRuc} / {binding.issuerId}</dd></div><div><dt className="text-muted-foreground">Ambiente / documento</dt><dd>{binding.environment} / {binding.documentType === '01' ? 'Factura (01)' : 'Boleta (03)'}</dd></div>
    <div><dt className="text-muted-foreground">Sede</dt><dd className="break-all font-mono text-xs">{binding.branchId}</dd></div><div><dt className="text-muted-foreground">Punto de emisión</dt><dd className="break-all font-mono text-xs">{binding.pointId}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">Serie</dt><dd className="break-all font-mono text-xs">{binding.seriesId}</dd></div>
  </dl>)}</div></div>;
}

export function IntegrationAdminEditor({ client, onPrepare, onCancel }: { client?: IntegrationAdminClient; onPrepare: (input: IntegrationAdminCreate) => void; onCancel: () => void }) {
  const prefix = useId();
  const [label, setLabel] = useState(client?.label ?? '');
  const [kind, setKind] = useState<'SERVICE' | 'USER'>(client?.kind ?? 'SERVICE');
  const [oidcClientId, setOidcClientId] = useState(client?.oidcClientId ?? '');
  const [scopes, setScopes] = useState<string[]>(client ? [...client.scopes] : []);
  const [bindings, setBindings] = useState<BindingDraft[]>(client ? client.bindings.map(binding => ({ ...binding, issuerId: String(binding.issuerId) })) : [blankBinding()]);
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const input: IntegrationAdminCreate = { label: label.trim(), kind, ...(kind === 'USER' ? { oidcClientId: oidcClientId.trim() } : {}), scopes: [...scopes], bindings: bindings.map(binding => ({ ...binding, issuerId: Number(binding.issuerId), issuerRuc: binding.issuerRuc.trim(), branchId: binding.branchId.trim(), pointId: binding.pointId.trim(), seriesId: binding.seriesId.trim(), documentType: binding.documentType as '01' | '03', environment: 'BETA' })) };
    const invalid = integrationAdminInputError(input);
    if (invalid) { setError(invalid); return; }
    setError(''); onPrepare(input);
  }
  function bindingChange(index: number, field: keyof BindingDraft, value: string) {
    setBindings(rows => rows.map((row, at) => at === index ? { ...row, [field]: value } : row));
  }
  return <form onSubmit={submit} className="space-y-5" aria-describedby={error ? `${prefix}-error` : undefined}>
    {error && <p id={`${prefix}-error`} role="alert" className={alertClass}>{error}</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor={`${prefix}-label`}>Nombre</Label><Input id={`${prefix}-label`} value={label} maxLength={120} required disabled={!!client} onChange={event => setLabel(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor={`${prefix}-kind`}>Tipo de acceso</Label><select id={`${prefix}-kind`} value={kind} disabled={!!client} className={selectClass} onChange={event => setKind(event.target.value as 'SERVICE' | 'USER')}><option value="SERVICE">Servicio</option><option value="USER">Usuario con OIDC</option></select></div>
      {kind === 'USER' && <div className="space-y-2 sm:col-span-2"><Label htmlFor={`${prefix}-oidc`}>Identificador del cliente OIDC</Label><Input id={`${prefix}-oidc`} value={oidcClientId} maxLength={120} required disabled={!!client} autoComplete="off" onChange={event => setOidcClientId(event.target.value)} /></div>}
    </div>
    <fieldset className="space-y-3"><legend className="text-sm font-semibold">Permisos</legend><p className="text-sm text-muted-foreground">Selecciona sólo los necesarios. La disponibilidad final se valida en el servidor.</p><div className="grid gap-2 sm:grid-cols-2">{integrationAdminScopes.map((scope, index) => <label key={scope} htmlFor={`${prefix}-scope-${index}`} className="flex min-w-0 items-start gap-2 rounded-md border p-2 text-xs"><input id={`${prefix}-scope-${index}`} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={scopes.includes(scope)} onChange={event => setScopes(old => event.target.checked ? [...old, scope] : old.filter(value => value !== scope))} /><span className="break-all font-mono">{scope}</span></label>)}</div></fieldset>
    <fieldset className="space-y-3"><legend className="text-sm font-semibold">Alcances autorizados</legend><p className="text-sm text-muted-foreground">Ambiente BETA. Usa los identificadores vigentes del catálogo para sede, punto y serie.</p>
      {bindings.map((binding, index) => <fieldset key={index} className="space-y-3 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">Alcance {index + 1}</legend><div className="grid gap-3 sm:grid-cols-2">
        {([['issuerId', 'Emisor (ID)'], ['issuerRuc', 'RUC'], ['branchId', 'Sede (ID)'], ['pointId', 'Punto de emisión (ID)'], ['seriesId', 'Serie (ID)']] as const).map(([field, title]) => <div className="space-y-2" key={field}><Label htmlFor={`${prefix}-${index}-${field}`}>{title}</Label><Input id={`${prefix}-${index}-${field}`} value={binding[field]} required autoComplete="off" inputMode={field === 'issuerId' || field === 'issuerRuc' ? 'numeric' : 'text'} maxLength={field === 'issuerRuc' ? 11 : 36} onChange={event => bindingChange(index, field, event.target.value)} /></div>)}
        <div className="space-y-2"><Label htmlFor={`${prefix}-${index}-documentType`}>Tipo de documento</Label><select id={`${prefix}-${index}-documentType`} value={binding.documentType} required className={selectClass} onChange={event => bindingChange(index, 'documentType', event.target.value)}><option value="">Seleccionar documento</option><option value="01">Factura (01)</option><option value="03">Boleta (03)</option></select></div>
      </div><Button type="button" variant="ghost" size="sm" disabled={bindings.length === 1} onClick={() => setBindings(rows => rows.filter((_, at) => at !== index))} aria-label={`Quitar alcance ${index + 1}`}>Quitar alcance</Button></fieldset>)}
      <Button type="button" variant="outline" disabled={bindings.length >= 500} onClick={() => setBindings(rows => [...rows, blankBinding()])}>Añadir alcance</Button>
    </fieldset>
    <DialogFooter><Button type="button" variant="outline" onClick={onCancel}>Cancelar</Button><Button type="submit">Revisar y confirmar</Button></DialogFooter>
  </form>;
}

