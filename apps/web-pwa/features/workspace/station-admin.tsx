"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StationAdminCatalog, StationSeriesType } from '@factuez/contracts';
import { Building2, CircleCheck, CirclePause, LoaderCircle, MapPin, Pencil, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { Badge } from '@factuez/ui/components/badge';
import { Button } from '@factuez/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@factuez/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@factuez/ui/components/tabs';
import { ApiError, useWorkspace } from './provider';
import { Empty, ErrorState, Loading, PageHeading } from './common';
import { canAdminMasters, emptyMasterDraft, masterCommand, masterDraftError, masterDraftFor, seriesLabels, type MasterDialog, type MasterDraft } from './station-admin-model';

function MasterStatus({ active, effective = active }: { active: boolean; effective?: boolean }) {
  return <Badge variant="outline" className={effective ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-100 text-slate-600'}>
    {effective ? 'Activo' : active ? 'Bloqueado por su sede o emisor' : 'Inactivo'}
  </Badge>;
}
export function StationAdminWorkspace({ products }: { products: ReactNode }) {
  const { user } = useWorkspace();
  if (!canAdminMasters(user)) return <ErrorState message="Este CRUD requiere el rol de administrador general y el permiso de configuración." />;
  return <StationAdminScope key={`${user!.sub}:${user!.permissions.join(',')}`} products={products} />;
}
function StationAdminScope({ products }: { products: ReactNode }) {
  const { api, can, reloadCatalog, setDirty, companyId: headerCompany, branchId: headerBranch } = useWorkspace();
  const [catalog, setCatalog] = useState<StationAdminCatalog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState('active');
  const [companyFilter, setCompanyFilter] = useState(headerCompany || 'all');
  const [branchFilter, setBranchFilter] = useState(headerBranch || 'all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<MasterDialog>();
  const [draft, setDraft] = useState<MasterDraft>(emptyMasterDraft);
  const [changed, setChanged] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const writing = useRef(false);
  const loadVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadVersion.current++; setDirty(false); }; }, [setDirty]);
  const load = useCallback(async () => {
    const stamp = ++loadVersion.current;
    setLoading(true); setError(undefined);
    try {
      const result = await api<StationAdminCatalog>('/api/v1/stations/admin/catalog', { signal: AbortSignal.timeout(10000) });
      if (result.version !== 'factuez.station-admin.v1' || typeof result.capabilities.betaOnly !== 'boolean' || result.capabilities.softDelete !== true || result.capabilities.counterEditing !== false) throw new Error('Contrato de maestros no compatible; no se habilitó la edición.');
      if (mounted.current && stamp === loadVersion.current) setCatalog(result);
    } catch (reason) {
      if (mounted.current && stamp === loadVersion.current) { setCatalog(undefined); setError(reason instanceof Error ? reason.message : 'No se pudieron cargar los maestros.'); }
    } finally { if (mounted.current && stamp === loadVersion.current) setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  function resetDialog() { setDialog(undefined); setChanged(false); setDirty(false); setDiscard(false); setFormError(undefined); setConflict(false); }
  function close() { if (writing.current) return; if (changed) setDiscard(true); else resetDialog(); }
  function open(value: MasterDialog) {
    if (!catalog || writing.current || dialog) return;
    setDraft(masterDraftFor(value, catalog)); setDialog(value); setFormError(undefined); setConflict(false); setNotice(undefined); setChanged(false);
  }
  function update<K extends keyof MasterDraft>(key: K, value: MasterDraft[K]) {
    if (writing.current) return;
    setDraft(previous => ({ ...previous, [key]: value })); setChanged(true); setDirty(true); if (!conflict) setFormError(undefined);
  }
  async function save() {
    if (!dialog || writing.current || conflict || masterDraftError(dialog, draft)) return;
    writing.current = true; setBusy(true); setFormError(undefined);
    try {
      const command = masterCommand(dialog, draft);
      await api(command.path, { method: command.method, body: JSON.stringify(command.body), signal: AbortSignal.timeout(15000) });
      if (!mounted.current) return;
      resetDialog(); setNotice(dialog.mode === 'deactivate' ? 'Registro desactivado. Su historial y correlativos se conservan.' : dialog.mode === 'reactivate' ? 'Registro reactivado, sin alterar sus correlativos.' : 'Cambios guardados y auditados.');
      await load();
      try { await reloadCatalog(); } catch { if (mounted.current) setNotice('Cambios guardados. Recarga el catálogo operativo si los selectores de la cabecera no se actualizan.'); }
    } catch (reason) {
      if (!mounted.current) return;
      const uncertain = !(reason instanceof ApiError) || reason.status >= 500;
      // Un timeout puede haber confirmado el cambio: no reenviar automáticamente.
      setConflict(uncertain || reason instanceof ApiError && reason.status === 409);
      setFormError(uncertain ? 'No se pudo confirmar la respuesta. No repitas el guardado: recarga y comprueba el registro antes de intentarlo de nuevo.' : reason instanceof Error ? reason.message : 'No se pudo guardar.');
    } finally { writing.current = false; if (mounted.current) setBusy(false); }
  }
  const companies = catalog?.companies ?? [];
  const branches = catalog?.branches ?? [];
  const points = catalog?.emissionPoints ?? [];
  const counters = catalog?.series ?? [];
  const query = search.trim().toLocaleLowerCase('es-PE');
  const matchText = (...values: (string | null | undefined)[]) => !query || values.some(value => value?.toLocaleLowerCase('es-PE').includes(query));
  const matchState = (effective: boolean) => filter === 'all' || (filter === 'active' ? effective : !effective);
  const companyFor = (id: number) => companies.find(company => company.id === id);
  const scopeBranch = (branch: (typeof branches)[number]) => (companyFilter === 'all' || String(branch.companyId) === companyFilter) && (branchFilter === 'all' || branch.id === branchFilter);
  const filteredBranches = branches.filter(branch => {
    if (!scopeBranch(branch)) return false;
    const ownPoints = points.filter(point => point.branchId === branch.id);
    const ownSeries = counters.filter(counter => ownPoints.some(point => point.id === counter.emissionPointId));
    return (matchState(branch.effectiveActive) || ownPoints.some(p => matchState(p.effectiveActive)) || ownSeries.some(s => matchState(s.effectiveActive))) &&
      matchText(branch.name, branch.code, branch.establishmentCode, companyFor(branch.companyId)?.ruc, ...ownPoints.flatMap(p => [p.name, p.code]), ...ownSeries.map(s => s.series));
  });
  function actions(kind: MasterDialog['kind'], id: string, revision: number, title: string, active: boolean, disabled = false, canRename?: boolean) {
    if (!can(kind === 'issuer' || kind === 'branch' ? 'setup.manage' : 'series.manage')) return null;
    return <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="outline" disabled={busy || loading} aria-label={`Editar ${title}`} onClick={() => open({ kind, mode: 'edit', targetId: id, revision, title, canRename })}><Pencil className="size-3.5" />{kind === 'series' && !canRename ? 'Ver serie' : 'Editar'}</Button>
      <Button size="sm" variant="ghost" disabled={busy || loading || !active && disabled} aria-label={`${active ? 'Desactivar' : 'Reactivar'} ${title}`} onClick={() => open({ kind, mode: active ? 'deactivate' : 'reactivate', targetId: id, revision, title })}>
        {active ? <CirclePause className="size-3.5" /> : <CircleCheck className="size-3.5" />}{active ? 'Desactivar' : 'Reactivar'}
      </Button>
    </div>;
  }
  const statusMode = dialog?.mode === 'deactivate' || dialog?.mode === 'reactivate';
  const dialogName = dialog?.kind === 'issuer' ? 'emisor' : dialog?.kind === 'branch' ? 'sede' : dialog?.kind === 'point' ? 'punto de emisión' : dialog?.kind === 'assign' ? 'emisor de la sede' : 'serie';
  const validation = dialog ? masterDraftError(dialog, draft) : undefined;
  function field(key: keyof MasterDraft, label: string, maxLength: number, readOnly = false, numeric = false) {
    const upper = ['code', 'invoiceSeries', 'receiptSeries', 'series'].includes(key);
    return <div className="space-y-2" key={key}><Label htmlFor={`master-${key}`}>{label}</Label><Input id={`master-${key}`} value={draft[key]} maxLength={maxLength} readOnly={readOnly} disabled={busy || conflict}
      inputMode={numeric ? 'numeric' : undefined} onChange={event => update(key, (numeric ? event.target.value.replace(/\D/g, '') : upper ? event.target.value.toUpperCase() : event.target.value) as never)} />
    </div>;
  }
  return <>
    <PageHeading eyebrow={catalog?.capabilities.betaOnly === false ? "Administración general · Beta / Producción" : "Administración general · Beta"} title="Sedes y maestros" description="Administra emisores, sedes, puntos y series. Los comprobantes históricos y sus correlativos no se modifican."
      action={<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading || busy || !catalog} onClick={() => open({ kind: 'issuer', mode: 'create' })}><Plus className="size-4" />Nuevo emisor RUC</Button>
        <Button disabled={loading || busy || !companies.some(c => c.active)} onClick={() => open({ kind: 'branch', mode: 'create' })}><Plus className="size-4" />Nueva sede</Button></div>} />
    {notice && <div role="status" className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</div>}
    <Tabs defaultValue="branches">
      <TabsList className="mb-5 h-auto max-w-full flex-wrap"><TabsTrigger value="issuers">Emisores RUC</TabsTrigger><TabsTrigger value="branches">Sedes, puntos y series</TabsTrigger><TabsTrigger value="products">Catálogo de productos</TabsTrigger></TabsList>
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <div className="min-w-40 flex-1 space-y-2"><Label htmlFor="master-search">Buscar maestros</Label><div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input id="master-search" className="pl-9" value={search} placeholder="RUC, sede, punto o serie…" onChange={e => setSearch(e.target.value)} /></div></div>
        <div className="space-y-2"><Label>Emisor</Label><Select value={companyFilter} onValueChange={value => { setCompanyFilter(value); setBranchFilter('all'); }}><SelectTrigger aria-label="Filtrar maestros por emisor" className="w-60"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{catalog?.capabilities.betaOnly ? 'Todos los emisores Beta' : 'Todos los emisores'}</SelectItem>{companies.map(c => <SelectItem value={String(c.id)} key={c.id}>{c.ruc} · {c.legalName}{c.active ? '' : ' (inactivo)'}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>Sede</Label><Select value={branchFilter} onValueChange={setBranchFilter}><SelectTrigger aria-label="Filtrar maestros por sede" className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todas las sedes</SelectItem>{branches.filter(b => companyFilter === 'all' || String(b.companyId) === companyFilter).map(b => <SelectItem value={b.id} key={b.id}>{b.name}{b.effectiveActive ? '' : ' (inactiva)'}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>Estado</Label><Select value={filter} onValueChange={setFilter}><SelectTrigger aria-label="Estado de maestros" className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Activos</SelectItem><SelectItem value="inactive">Inactivos</SelectItem><SelectItem value="all">Todos</SelectItem></SelectContent></Select></div>
        <Button variant="outline" disabled={loading || busy || !!dialog} aria-label="Actualizar maestros" onClick={() => void load()}><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</Button>
      </div>
      {loading && <Loading />}{error && <ErrorState message={error} retry={() => void load()} />}
      {!loading && catalog && <>
        <TabsContent value="issuers"><div className="grid gap-5 xl:grid-cols-2">
          {companies.filter(c => (companyFilter === 'all' || String(c.id) === companyFilter) && matchState(c.active) && matchText(c.ruc, c.legalName, c.tradeName)).map(company => <Card key={company.id} className="shadow-none">
            <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><Badge variant="outline" className="font-mono">RUC {company.ruc}</Badge><MasterStatus active={company.active} /></div><CardTitle>{company.legalName}</CardTitle><CardDescription>{company.tradeName || 'Nombre comercial no configurado'} · {company.environment === 'PRODUCTION' ? 'Producción' : 'Beta'}</CardDescription></CardHeader>
            <CardContent className="space-y-4 text-sm"><div className="space-y-1 text-muted-foreground"><p>{company.taxAddress}</p><p>Ubigeo {company.ubigeo}{company.phone ? ` · ${company.phone}` : ''}</p>{!!company.contactEmails.length && <p className="break-words">{company.contactEmails.join(', ')}</p>}<p>{branches.filter(b => b.companyId === company.id).length} sedes registradas · Revisión {company.revision}</p></div>
              {actions('issuer', String(company.id), company.revision, company.legalName, company.active)}<p className="text-xs text-muted-foreground">RUC inmutable. Certificado y credenciales se configuran por separado; estos cambios no habilitan emisión oficial.</p></CardContent>
          </Card>)}
        </div>{!companies.some(c => (companyFilter === 'all' || String(c.id) === companyFilter) && matchState(c.active) && matchText(c.ruc, c.legalName, c.tradeName)) && <Empty title="Sin emisores para este filtro" description="Prueba Todos para ver y reactivar registros inactivos." />}</TabsContent>
        <TabsContent value="branches"><div className="space-y-5">
          {filteredBranches.map(branch => {
            const company = companyFor(branch.companyId);
            const ownPoints = points.filter(p => p.branchId === branch.id);
            const showAll = matchText(branch.name, branch.code, branch.establishmentCode, company?.ruc);
            const visiblePoints = ownPoints.filter(point => (matchState(point.effectiveActive) || counters.some(s => s.emissionPointId === point.id && matchState(s.effectiveActive))) && (showAll || matchText(point.name, point.code, ...counters.filter(s => s.emissionPointId === point.id).map(s => s.series))));
            return <Card key={branch.id} className="shadow-none"><CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2"><Badge variant="outline"><Building2 className="mr-1 size-3" />{branch.code}</Badge><MasterStatus active={branch.active} effective={branch.effectiveActive} /></div>
                <div className="flex flex-wrap gap-2">{actions('branch', branch.id, branch.revision, branch.name, branch.active, !company?.active)}
                  {can('series.manage') && <Button variant="outline" size="sm" disabled={!branch.effectiveActive || busy} onClick={() => open({ kind: 'point', mode: 'create', parentId: branch.id, title: branch.name })}><Plus className="size-3.5" />Punto de emisión</Button>}</div>
              </div><CardTitle>{branch.name}</CardTitle><CardDescription>{company?.legalName} · RUC {company?.ruc} · {ownPoints.length} puntos · Revisión {branch.revision}</CardDescription>
              <CardDescription className="flex items-center gap-1"><MapPin className="size-3.5 shrink-0" />{branch.address || 'Dirección pendiente'}</CardDescription>
              <CardDescription>Establecimiento SUNAT: {branch.establishmentCode ?? 'Sin configurar'} · {company?.environment === 'PRODUCTION' ? 'Producción' : 'Beta'}</CardDescription>
              <div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="sm" className="w-fit" disabled={branch.pointCount > 0 || !branch.effectiveActive || busy} onClick={() => open({ kind: 'assign', mode: 'edit', targetId: branch.id, revision: branch.revision, title: branch.name })}>Cambiar emisor</Button>
                {branch.pointCount > 0 && <span className="text-xs text-muted-foreground">RUC protegido: la sede ya tiene puntos.</span>}{branch.openShiftCount > 0 && <span className="text-xs text-amber-700">{branch.openShiftCount} turnos abiertos; deben cerrarse antes de desactivar.</span>}</div>
            </CardHeader><CardContent className="space-y-4">
              {visiblePoints.map(point => <section key={point.id} className="rounded-xl border bg-background p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h3 className="font-medium">{point.name}</h3><p className="text-xs text-muted-foreground">{point.code}{point.trackNumber !== null ? ` · Pista ${point.trackNumber}` : ''} · Revisión {point.revision}</p><MasterStatus active={point.active} effective={point.effectiveActive} />{point.address && <p className="text-xs text-muted-foreground">{point.address}</p>}</div>
                  <div className="flex flex-wrap gap-2">{actions('point', point.id, point.revision, point.name, point.active, !branch.effectiveActive)}{can('series.manage') && <Button variant="outline" size="sm" disabled={!point.effectiveActive || busy} onClick={() => open({ kind: 'series', mode: 'create', parentId: point.id, title: point.name })}><Plus className="size-3.5" />Nueva serie</Button>}</div></div>
                <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Tipo</TableHead><TableHead>Serie</TableHead><TableHead>Siguiente correlativo</TableHead><TableHead>Comprobantes</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Acciones</TableHead></TableRow></TableHeader><TableBody>
                  {counters.filter(s => s.emissionPointId === point.id && matchState(s.effectiveActive)).map(counter => <TableRow key={counter.id}><TableCell>{seriesLabels[counter.documentType]}</TableCell><TableCell className="font-mono font-medium">{counter.series}</TableCell><TableCell className="font-mono tabular-nums">{counter.nextNumber.padStart(8, '0')}</TableCell><TableCell>{counter.documentCount}</TableCell><TableCell><MasterStatus active={counter.active} effective={counter.effectiveActive} /></TableCell><TableCell>{actions('series', counter.id, counter.revision, `${counter.series} (${point.name})`, counter.active, !point.effectiveActive, counter.canRename)}</TableCell></TableRow>)}
                  {!counters.some(s => s.emissionPointId === point.id && matchState(s.effectiveActive)) && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Sin series en este filtro.</TableCell></TableRow>}
                </TableBody></Table></div>
              </section>)}
              {!visiblePoints.length && <Empty title="Sin puntos para este filtro" description="Crea un punto de emisión o selecciona Todos para revisar los inactivos." />}
            </CardContent></Card>;
          })}
          {!filteredBranches.length && <Empty title="Sin sedes para este filtro" description="Crea una sede o cambia los filtros para revisar registros inactivos." />}
          <div className="flex items-start gap-2 rounded-xl border p-4 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="size-4 shrink-0" /><p>Desactivar conserva el historial y bloquea nuevas emisiones. No se trasladan puntos ni series a otro RUC. Sólo se puede renombrar una serie sin comprobantes y con siguiente correlativo 1; el correlativo nunca se edita ni se reinicia. La serie inactiva sigue reservada a su RUC y tipo.</p></div>
        </div></TabsContent>
      </>}
      <TabsContent value="products">{products}</TabsContent>
    </Tabs>
    <Dialog open={!!dialog} onOpenChange={value => { if (!value) close(); }}><DialogContent showCloseButton={!busy} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{statusMode ? dialog?.mode === 'deactivate' ? `Desactivar ${dialogName}` : `Reactivar ${dialogName}` : dialog?.kind === 'assign' ? 'Cambiar emisor de la sede' : dialog?.mode === 'create' ? `Crear ${dialogName}` : `Editar ${dialogName}`}</DialogTitle>
        <DialogDescription>{statusMode ? `${dialog?.title}. ${dialog?.mode === 'deactivate' ? 'No se eliminará el historial, no se borrarán archivos y no se liberará la numeración. Sus dependencias dejarán de estar disponibles para nuevas emisiones.' : 'Se conservan todos los datos y el siguiente correlativo. Los hijos desactivados por separado seguirán inactivos.'}`
          : dialog?.kind === 'assign' ? 'Sólo una sede sin puntos puede cambiar de emisor. Nunca se traslada el historial fiscal.' : `${dialog?.title ? `${dialog.title} · ` : ''}Configuración de maestros. Los cambios se aplican a nuevas emisiones del ambiente del emisor y conservan los comprobantes registrados.`}</DialogDescription></DialogHeader>
      {!statusMode && <fieldset disabled={busy || conflict} className="grid gap-4 sm:grid-cols-2">
        {(dialog?.kind === 'assign' || dialog?.kind === 'branch' && dialog.mode === 'create') && <div className="space-y-2 sm:col-span-2"><Label>Emisor fiscal</Label><Select value={draft.companyId} disabled={busy || conflict} onValueChange={value => update('companyId', value)}><SelectTrigger aria-label="Emisor fiscal del formulario" className="w-full"><SelectValue placeholder="Seleccionar emisor" /></SelectTrigger><SelectContent>{companies.filter(c => c.active).map(c => <SelectItem key={c.id} value={String(c.id)}>{c.ruc} · {c.legalName}</SelectItem>)}</SelectContent></Select></div>}
        {dialog?.kind === 'issuer' && <>{field('ruc', 'RUC (inmutable al editar)', 11, dialog.mode === 'edit', true)}{field('ubigeo', 'Ubigeo fiscal', 6, false, true)}{field('legalName', 'Razón social', 200)}{field('tradeName', 'Nombre comercial', 200)}<div className="sm:col-span-2">{field('taxAddress', 'Dirección fiscal', 300)}</div>{field('phone', 'Teléfono', 40)}{field('contactEmails', 'Correos de contacto (separados por coma)', 2560)}</>}
        {(dialog?.kind === 'branch' || dialog?.kind === 'point') && <>{field('code', 'Código único', 20)}{field('name', 'Nombre', 120)}{dialog.kind === 'branch' && <div className="space-y-2">{field('establishmentCode', 'Establecimiento SUNAT (opcional, 4 dígitos)', 4)}<p className="text-xs text-muted-foreground">Todos los puntos de esta sede comparten este establecimiento. Es obligatorio para emitir en Producción. Vacío elimina la configuración.</p></div>}<div className="sm:col-span-2">{field('address', 'Dirección', 300)}</div>{dialog.kind === 'point' && field('trackNumber', 'Número de pista (opcional)', 4, false, true)}{dialog.kind === 'point' && dialog.mode === 'create' && <>{field('invoiceSeries', 'Serie inicial de factura', 4)}{field('receiptSeries', 'Serie inicial de boleta', 4)}</>}</>}
        {dialog?.kind === 'series' && <><div className="space-y-2"><Label>Tipo de documento</Label><Select value={draft.documentType} disabled={busy || conflict || dialog.mode === 'edit'} onValueChange={value => update('documentType', value as StationSeriesType)}><SelectTrigger aria-label="Tipo de documento de la serie" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(seriesLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>{field('series', 'Serie (4 caracteres)', 4, dialog.mode === 'edit' && !dialog.canRename)}
          <p className="sm:col-span-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">{dialog.mode === 'edit' && !dialog.canRename ? 'La serie tiene historial o numeración consumida: no puede renombrarse. Puedes desactivarla y crear otra, conservando su historial.' : 'La numeración inicia en 1 únicamente al crear una nueva serie. No existe edición manual del correlativo.'}</p></>}
      </fieldset>}
      {formError && <ErrorState message={formError} />}{!statusMode && validation && changed && <p className="text-sm text-muted-foreground">{validation}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>Cancelar</Button>{conflict ? <Button disabled={busy} onClick={() => setDiscard(true)}>Recargar maestros</Button> : <Button disabled={busy || !!validation || !statusMode && (!changed && dialog?.mode !== 'create' || dialog?.kind === 'series' && dialog.mode === 'edit' && !dialog.canRename)} onClick={() => void save()}>
        {busy && <LoaderCircle className="size-4 animate-spin" />}{statusMode ? dialog?.mode === 'deactivate' ? 'Confirmar desactivación' : 'Confirmar reactivación' : 'Guardar cambios'}</Button>}</DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={value => { if (!busy) setDiscard(value); }}><DialogContent><DialogHeader><DialogTitle>{conflict ? 'Recargar y comprobar el registro' : 'Descartar cambios sin guardar'}</DialogTitle><DialogDescription>{conflict ? 'Se descartará el borrador y se consultará la revisión actual. Si hubo una respuesta incierta, comprueba primero si el cambio ya quedó guardado.' : 'El borrador no se guardará. Los datos registrados en el servidor no cambiarán.'}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(false)}>Volver al formulario</Button><Button onClick={() => { const reload = conflict; resetDialog(); if (reload) void load(); }}>Descartar{conflict ? ' y recargar' : ''}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
