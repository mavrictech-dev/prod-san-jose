"use client";

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Download, RefreshCw, Upload } from 'lucide-react';
import { Badge } from '@factuez/ui/components/badge';
import { Button } from '@factuez/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@factuez/ui/components/table';
import type { ReceivedDocumentDetail, ReceivedDocumentPage, ReceivedDocumentRow, ReceivedTax, ReceivedUploadResult } from '@factuez/contracts';
import { Empty, ErrorState, Loading, PageHeading } from './common';
import { ApiError, useResource, useWorkspace } from './provider';
import type { Branch, User } from './types';
import { ReceivedAutomationPanel } from './received-automation';
import { receivedListDirty } from './received-automation-model';
import {
  createReceivedOperation, EMPTY_RECEIVED_FILTERS, readReceivedFiles, RECEIVED_API, RECEIVED_NOTICE,
  RECEIVED_PDF_NOTICE, RECEIVED_XLSX_TYPE, receivedAmount, receivedFileError, receivedFilterError,
  receivedQuery, receivedRegistration, receivedRowInScope, receivedSelection, receivedTypeLabel,
  receivedUploadCommand, saveReceivedBlob,
  type ReceivedFileKind, type ReceivedFilters, type ReceivedSelection,
} from './received-documents-model';

function message(error: unknown) { return error instanceof Error ? error.message : 'No se pudo completar la operación.'; }

function useReceivedAction() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const operation = useRef(createReceivedOperation());
  const pending = useRef(false);
  useEffect(() => () => { operation.current.cancel(); pending.current = false; }, []);
  async function run<T>(label: string, work: (signal: AbortSignal) => Promise<T>, done: (value: T) => void = () => {}) {
    if (pending.current) return;
    pending.current = true;
    const controller = operation.current.start();
    setBusy(label); setError(undefined);
    try {
      const value = await work(controller.signal);
      if (operation.current.current(controller)) done(value);
    } catch (reason) {
      if (operation.current.current(controller)) setError(message(reason));
    } finally {
      if (operation.current.current(controller)) { pending.current = false; setBusy(undefined); }
    }
  }
  return { busy, error, setError, run };
}

/** Remount before displaying data when RUC, branch, source or authorization changes. */
export function ReceivedDocuments({ id }: { id?: string }) {
  const workspace = useWorkspace();
  const { user, can, catalog, companyId, branchId, catalogSource, catalogError, reloadCatalog } = workspace;
  if (!can('report.view')) return <ErrorState message="No tienes permiso para consultar documentos recibidos." />;
  if (catalogError) return <ErrorState message={catalogError} retry={() => void reloadCatalog()} />;
  if (!catalog) return <Loading />;
  const selection = receivedSelection(catalog, user, companyId, branchId);
  if (!selection) return <>
    <PageHeading eyebrow="Compras y recepción" title="Documentos recibidos" description={RECEIVED_NOTICE} />
    <Empty title="Selecciona un RUC" description={user?.scope.kind === 'ASSIGNED' ? 'Selecciona un RUC y una sede asignada en los filtros del espacio de trabajo.' : 'Selecciona la empresa receptora en el filtro RUC del espacio de trabajo para consultar o cargar documentos.'} />
  </>;
  const contextKey = JSON.stringify([id, companyId, branchId, catalogSource, user?.sub, user?.scope, user?.permissions, selection.company.ruc]);
  selection.dataSource = catalogSource;
  return id ? <ReceivedDetailResource key={contextKey} id={id} selection={selection} /> : <ReceivedList key={contextKey} selection={selection} />;
}

export function ReceivedDocumentTable({ items }: { items: ReceivedDocumentRow[] }) {
  if (!items.length) return <Empty title="Sin documentos recibidos" description="Los XML recibidos por los conectores habilitados aparecerán aquí. También puedes importar archivos o ajustar los filtros." />;
  return <Table>
    <TableHeader><TableRow>
      <TableHead>Documento / proveedor</TableHead><TableHead>RUC proveedor / receptor</TableHead><TableHead>Fecha de emisión</TableHead>
      <TableHead className="text-right">Total</TableHead><TableHead>SUNAT</TableHead><TableHead>Registro interno</TableHead><TableHead>Detalle</TableHead>
    </TableRow></TableHeader>
    <TableBody>{items.map(row => <TableRow key={row.id}>
      <TableCell><p className="font-medium">{row.fullNumber}</p><p className="text-xs text-muted-foreground">{receivedTypeLabel(row.documentType)}</p><p className="max-w-64 truncate text-xs">{row.supplierName ?? 'Proveedor sin nombre'}</p></TableCell>
      <TableCell className="font-mono text-xs"><p>{row.supplierRuc}</p><p className="text-muted-foreground">Receptor: {row.recipientRuc}</p></TableCell>
      <TableCell>{row.issueDate}</TableCell><TableCell className="text-right tabular-nums">{receivedAmount(row.payableAmount, row.currencyCode)}</TableCell>
      <TableCell><Badge variant="outline">No consultado</Badge></TableCell>
      <TableCell><p>{row.registeredAt ? 'Registrado' : 'Pendiente'}</p>{row.erpReference && <p className="text-xs text-muted-foreground">{row.erpReference}</p>}</TableCell>
      <TableCell><Button asChild variant="outline" size="sm"><Link href={`/received/${encodeURIComponent(row.id)}`} aria-label={`Ver ${row.fullNumber} de ${row.supplierRuc}`}>Ver detalle</Link></Button></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

export function ReceivedUploadForm({ enabled, busy, files, onFiles, onSubmit }: {
  enabled: boolean; busy?: string; files: readonly File[]; onFiles: (files: File[]) => void; onSubmit: () => void;
}) {
  if (!enabled) return null;
  const error = files.length ? receivedFileError(files) : undefined;
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (files.length && !error && !busy) onSubmit(); }}>
    <div><Label htmlFor="received-files">Importar XML o ZIP</Label>
      <Input id="received-files" type="file" multiple accept=".xml,.zip" disabled={!!busy} aria-describedby="received-upload-help" onChange={event => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <p id="received-upload-help" className="mt-2 text-xs text-muted-foreground">Hasta 10 archivos; 4 MiB por archivo y 12 MiB en total. Los ZIP pueden incluir pares XML + PDF del proveedor.</p>
    </div>
    {!!files.length && <ul className="text-xs">{files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name} · {file.size} bytes</li>)}</ul>}
    {error && <ErrorState message={error} />}
    <div className="flex gap-2"><Button type="submit" disabled={!!busy || !files.length || !!error}><Upload className="size-4" />{busy === 'upload' ? 'Importando…' : 'Importar manualmente'}</Button>
      {!!files.length && <Button type="button" variant="outline" disabled={!!busy} onClick={() => onFiles([])}>Quitar selección</Button>}
    </div>
  </form>;
}

export function ReceivedUploadResults({ result }: { result: ReceivedUploadResult }) {
  const labels = { IMPORTED: 'Importado', DUPLICATE: 'Duplicado', REJECTED: 'Rechazado al importar' };
  return <div role="status" className="space-y-2 rounded-lg border p-4 text-sm"><p className="font-medium">Resultado de la carga manual</p>
    {result.results.map((row, index) => <p key={`${row.fileName}-${index}`}><span className="font-medium">{row.fileName}: {labels[row.outcome]}</span> · {row.message}
      {row.id && row.outcome !== 'REJECTED' && <Link className="ml-2 underline" href={`/received/${encodeURIComponent(row.id)}`}>Ver detalle</Link>}
    </p>)}<p className="text-xs text-muted-foreground">Estos resultados describen la importación local. SUNAT: No consultado.</p>
  </div>;
}

function ReceivedList({ selection }: { selection: ReceivedSelection }) {
  const { api, apiBlob, can, setDirty } = useWorkspace();
  const action = useReceivedAction();
  const [draft, setDraft] = useState<ReceivedFilters>({ ...EMPTY_RECEIVED_FILTERS });
  const [filters, setFilters] = useState<ReceivedFilters>({ ...EMPTY_RECEIVED_FILTERS });
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<ReceivedUploadResult>();
  const [refresh, setRefresh] = useState(0);
  const [automationDirty, setAutomationDirty] = useState(false);
  const onDirtyChange = useCallback((value: boolean) => setAutomationDirty(value), []);
  const importDirty = !!files.length || !!action.busy;
  const dirty = receivedListDirty(importDirty, automationDirty);
  const canImport = can('setup.manage');
  const canExport = can('report.export');
  const query = receivedQuery(selection, filters);
  const filterError = receivedFilterError(draft);
  useEffect(() => { setDirty(dirty); }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);
  async function upload() {
    if (!canImport || !files.length || action.busy) return;
    setResult(undefined);
    await action.run('upload', async signal => {
      const encoded = await readReceivedFiles(files, 'UPLOAD', signal);
      signal.throwIfAborted();
      return api<ReceivedUploadResult>(RECEIVED_API, { method: 'POST', signal, body: JSON.stringify(receivedUploadCommand(selection, encoded)) });
    }, value => { setResult(value); setFiles([]); setRefresh(version => version + 1); });
  }
  async function exportExcel() {
    if (!canExport || action.busy) return;
    await action.run('export', signal => apiBlob(receivedQuery(selection, filters, true), signal, RECEIVED_XLSX_TYPE),
      blob => saveReceivedBlob(blob, `recibidos-${selection.company.ruc}.xlsx`));
  }
  function applyFilters(event: FormEvent) { event.preventDefault(); if (!filterError) setFilters({ ...draft, page: 1 }); }
  return <>
    <PageHeading eyebrow="Compras y recepción" title="Documentos recibidos" description={RECEIVED_NOTICE} action={canExport && <Button variant="outline" onClick={() => void exportExcel()} disabled={!!action.busy}><Download className="size-4" />{action.busy === 'export' ? 'Exportando…' : 'Exportar Excel'}</Button>} />
    <p className="mb-4 text-sm">Receptor: {selection.company.legalName} · RUC {selection.company.ruc}{selection.branchId ? ' · Sede seleccionada' : ' · Todas las sedes autorizadas'}</p>
    <div className="space-y-5">
      <ReceivedAutomationPanel selection={selection} onDirtyChange={onDirtyChange} />
      {canImport && <Card className="shadow-none"><CardContent><ReceivedUploadForm enabled={canImport} busy={action.busy} files={files} onFiles={value => { setFiles(value); setResult(undefined); action.setError(undefined); }} onSubmit={() => void upload()} /></CardContent></Card>}
      {action.error && <ErrorState message={action.error} />}
      {result && <ReceivedUploadResults result={result} />}
      <Card className="shadow-none"><CardContent>
        <form onSubmit={applyFilters} className="mb-5 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1"><Label htmlFor="received-search">Número, RUC o proveedor</Label><Input id="received-search" maxLength={100} value={draft.q} onChange={event => setDraft(value => ({ ...value, q: event.target.value }))} /></div>
          <div><Label htmlFor="received-type">Tipo de documento</Label><Select value={draft.type || 'ALL'} onValueChange={type => setDraft(value => ({ ...value, type: type === 'ALL' ? '' : type }))}><SelectTrigger id="received-type" className="w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">Todos los tipos</SelectItem>{['01', '03', '07', '08', '09', '31', '20', '40'].map(type => <SelectItem key={type} value={type}>{receivedTypeLabel(type)}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="received-from">Desde</Label><Input id="received-from" type="date" value={draft.from} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></div>
          <div><Label htmlFor="received-to">Hasta</Label><Input id="received-to" type="date" value={draft.to} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></div>
          <Button type="submit" variant="outline" disabled={!!filterError}>Filtrar</Button>
          <Button type="button" variant="outline" size="icon" aria-label="Actualizar documentos recibidos" onClick={() => setRefresh(version => version + 1)}><RefreshCw className="size-4" /></Button>
        </form>
        {filterError && <div className="mb-4"><ErrorState message={filterError} /></div>}
        <ReceivedPageResource key={`${query}:${refresh}`} selection={selection} query={query} onPage={page => setFilters(value => ({ ...value, page }))} />
      </CardContent></Card>
    </div>
  </>;
}

function ReceivedPageResource({ selection, query, onPage }: { selection: ReceivedSelection; query: string; onPage: (page: number) => void }) {
  const { data, error, reload } = useResource<ReceivedDocumentPage>(query, true);
  if (error) return <ErrorState message={error} retry={reload} />;
  if (!data) return <Loading />;
  if (data.items.some(row => !receivedRowInScope(row, selection))) return <ErrorState message="La respuesta no corresponde al RUC y la sede seleccionados." retry={reload} />;
  const pages = Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize)));
  return <><ReceivedDocumentTable items={data.items} /><div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
    <span>{data.total} resultados · Página {data.page} de {pages}</span><div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Anterior</Button>
      <Button variant="outline" size="sm" disabled={data.page >= pages} onClick={() => onPage(data.page + 1)}>Siguiente</Button>
    </div>
  </div></>;
}

function ReceivedDetailResource({ id, selection }: { id: string; selection: ReceivedSelection }) {
  const resource = useResource<ReceivedDocumentDetail>(`${RECEIVED_API}/${encodeURIComponent(id)}`);
  if (resource.error) return <><BackToReceived /><ErrorState message={resource.error} retry={resource.reload} /></>;
  if (!resource.data) return <><BackToReceived /><Loading /></>;
  if (resource.data.id !== id || !receivedRowInScope(resource.data, selection)) return <><BackToReceived /><ErrorState message="El documento no corresponde al RUC y la sede seleccionados." /></>;
  return <ReceivedDetail key={JSON.stringify([id, resource.data.registeredAt, resource.data.erpReference])} detail={resource.data} reload={resource.reload} />;
}

function BackToReceived() { return <Button asChild variant="ghost" className="mb-4"><Link href="/received"><ArrowLeft className="size-4" />Documentos recibidos</Link></Button>; }

function Facts({ children }: { children: ReactNode }) { return <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">{children}</dl>; }
function Fact({ title, value }: { title: string; value: ReactNode }) { return <div><dt className="text-xs text-muted-foreground">{title}</dt><dd className="mt-1 break-words">{value ?? '—'}</dd></div>; }

export function ReceivedTaxes({ taxes }: { taxes: ReceivedTax[] }) {
  if (!taxes.length) return <span className="text-xs text-muted-foreground">Sin desglose en XML</span>;
  return <ul className="space-y-2 text-xs">{taxes.map((tax, index) => <li key={index}>
    <p>{tax.name ?? 'Tributo'}{tax.schemeId ? ` · ${tax.schemeId}` : ''}: {receivedAmount(tax.amount)}</p>
    <p className="text-muted-foreground">Base: {receivedAmount(tax.taxableAmount)} · Tasa: {tax.percent === null ? '—' : `${tax.percent}%`} · Afectación: {tax.affectationCode ?? '—'}</p>
  </li>)}</ul>;
}

/** The projection is type-agnostic; unsupported document codes retain all fields. */
export function ReceivedProjection({ detail }: { detail: ReceivedDocumentDetail }) {
  const projection = detail.projection;
  const currency = projection.currencyCode;
  const totals: [string, string | null][] = [
    ['Valor de líneas', projection.totals.lineExtensionAmount], ['Total sin impuestos', projection.totals.taxExclusiveAmount],
    ['Total con impuestos', projection.totals.taxInclusiveAmount], ['Descuentos', projection.totals.allowanceTotalAmount],
    ['Cargos', projection.totals.chargeTotalAmount], ['Anticipos', projection.totals.prepaidAmount], ['Total por pagar', projection.totals.payableAmount],
  ];
  return <div className="space-y-5">
    <Card className="shadow-none"><CardHeader><CardTitle>Datos del XML</CardTitle></CardHeader><CardContent><Facts>
      <Fact title="Tipo / número" value={`${receivedTypeLabel(projection.documentType)} · ${projection.fullNumber}`} />
      <Fact title="Serie / correlativo" value={`${projection.series} / ${projection.number}`} />
      <Fact title="Emisión" value={`${projection.issueDate}${projection.issueTime ? ` ${projection.issueTime}` : ''}`} />
      <Fact title="Vencimiento" value={projection.dueDate} /><Fact title="Moneda" value={currency} /><Fact title="Sede (identificador)" value={detail.branchId} />
      <Fact title="Proveedor" value={projection.supplier.legalName} /><Fact title="Identidad del proveedor" value={`${projection.supplier.identityType ?? '—'} · ${projection.supplier.identityNumber ?? '—'}`} /><Fact title="Dirección del proveedor" value={projection.supplier.address} />
      <Fact title="Receptor" value={projection.recipient.legalName} /><Fact title="Identidad del receptor" value={`${projection.recipient.identityType ?? '—'} · ${projection.recipient.identityNumber ?? '—'}`} /><Fact title="Dirección del receptor" value={projection.recipient.address} />
      <Fact title="Firma XML" value={projection.signature.status === 'PRESENT_UNVERIFIED' ? 'Presente, sin verificar confianza oficial' : 'No presente'} />
      <Fact title="Consulta SUNAT" value="No consultado" /><Fact title="Recibido" value={detail.receivedAt} />
      <Fact title="SHA-256 XML" value={<span className="font-mono text-xs break-all">{projection.xmlSha256}</span>} />
    </Facts></CardContent></Card>
    <Card className="shadow-none"><CardHeader><CardTitle>Ítems del documento</CardTitle></CardHeader><CardContent>
      {!projection.items.length ? <Empty title="Sin ítems proyectados" description="Revisa las observaciones del XML y sus originales." /> : <Table>
        <TableHeader><TableRow><TableHead>Ítem / códigos</TableHead><TableHead>Descripción</TableHead><TableHead>Cantidad / unidad</TableHead><TableHead>Valor unitario</TableHead><TableHead>Precio unitario</TableHead><TableHead>Valor de línea</TableHead><TableHead>Descuentos / cargos</TableHead><TableHead>Tributos</TableHead></TableRow></TableHeader>
        <TableBody>{projection.items.map((item, index) => <TableRow key={`${item.lineId}-${index}`}>
          <TableCell><p>{item.lineId}</p><p className="text-xs">Proveedor: {item.supplierCode ?? '—'}</p><p className="text-xs">SUNAT: {item.sunatCode ?? '—'}</p></TableCell>
          <TableCell className="min-w-48 whitespace-normal">{item.description}</TableCell><TableCell>{item.quantity ?? '—'} · {item.unitCode ?? '—'}</TableCell>
          <TableCell>{receivedAmount(item.unitValue, currency)}</TableCell><TableCell>{receivedAmount(item.unitPrice, currency)}</TableCell><TableCell>{receivedAmount(item.lineExtensionAmount, currency)}</TableCell>
          <TableCell>{item.allowances.length ? <ul className="space-y-2 text-xs">{item.allowances.map((allowance, i) => <li key={i}>{allowance.charge ? 'Cargo' : 'Descuento'}: {receivedAmount(allowance.amount, currency)}{allowance.reason ? ` · ${allowance.reason}` : ''}</li>)}</ul> : '—'}</TableCell>
          <TableCell><ReceivedTaxes taxes={item.taxes} /></TableCell>
        </TableRow>)}</TableBody>
      </Table>}
    </CardContent></Card>
    <Card className="shadow-none"><CardHeader><CardTitle>Totales y tributos</CardTitle></CardHeader><CardContent><Facts>{totals.map(([title, value]) => <Fact key={title} title={title} value={receivedAmount(value, currency)} />)}</Facts><div className="mt-4"><ReceivedTaxes taxes={projection.taxes} /></div></CardContent></Card>
    <Card className="shadow-none"><CardHeader><CardTitle>Condiciones de pago y referencias</CardTitle></CardHeader><CardContent className="space-y-4">
      <Table><TableHeader><TableRow><TableHead>Condición</TableHead><TableHead>Medio / modalidad</TableHead><TableHead>Importe</TableHead><TableHead>Vencimiento</TableHead></TableRow></TableHeader>
        <TableBody>{projection.paymentTerms.length ? projection.paymentTerms.map((term, i) => <TableRow key={i}><TableCell>{term.id ?? '—'}</TableCell><TableCell>{term.means ?? '—'}</TableCell><TableCell>{receivedAmount(term.amount, currency)}</TableCell><TableCell>{term.dueDate ?? '—'}</TableCell></TableRow>) : <TableRow><TableCell colSpan={4}>Sin condiciones de pago en XML</TableCell></TableRow>}</TableBody>
      </Table>
      {projection.references.length ? <ul className="text-sm">{projection.references.map((ref, i) => <li key={i}>{ref.kind} · {ref.number ?? '—'} · Tipo {ref.documentType ?? '—'}</li>)}</ul> : <p className="text-sm text-muted-foreground">Sin referencias en XML</p>}
      {!!projection.notes.length && <div><p className="mb-2 text-sm font-medium">Notas</p><ul className="space-y-1 text-sm">{projection.notes.map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
    </CardContent></Card>
    {!!(detail.warnings.length || projection.warnings.length) && <Card className="shadow-none"><CardHeader><CardTitle>Observaciones de lectura</CardTitle></CardHeader><CardContent><ul className="space-y-2 text-sm">{[...new Set([...detail.warnings, ...projection.warnings])].map((warning, i) => <li key={i}>{warning}</li>)}</ul></CardContent></Card>}
  </div>;
}

export function ReceivedArtifacts({ detail, busy, onDownload, onGenerated }: {
  detail: ReceivedDocumentDetail; busy?: string; onDownload: (artifact: ReceivedDocumentDetail['artifacts'][number]) => void; onGenerated: () => void;
}) {
  const labels = { XML: 'XML original', PROVIDER_PDF: 'PDF original del proveedor', CDR: 'CDR adjunto, sin verificación fiscal' };
  return <Card className="shadow-none"><CardHeader><CardTitle>Archivos y copia de lectura</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">{RECEIVED_PDF_NOTICE}</p>
    <Button variant="outline" disabled={!!busy} onClick={onGenerated}><Download className="size-4" />Descargar copia PDF no fiscal</Button>
    <Table><TableHeader><TableRow><TableHead>Original</TableHead><TableHead>Archivo / SHA-256</TableHead><TableHead>Tamaño</TableHead><TableHead>Descarga</TableHead></TableRow></TableHeader>
      <TableBody>{detail.artifacts.length ? detail.artifacts.map(artifact => <TableRow key={artifact.id}>
        <TableCell>{labels[artifact.kind]}</TableCell><TableCell><p>{artifact.fileName}</p><p className="max-w-80 break-all font-mono text-xs text-muted-foreground">{artifact.sha256}</p></TableCell><TableCell>{artifact.byteLength} bytes</TableCell>
        <TableCell><Button variant="outline" size="sm" disabled={!!busy} onClick={() => onDownload(artifact)} aria-label={`Descargar ${artifact.fileName}`}><Download className="size-4" />Descargar original</Button></TableCell>
      </TableRow>) : <TableRow><TableCell colSpan={4}>Sin originales disponibles</TableCell></TableRow>}</TableBody>
    </Table>
  </CardContent></Card>;
}

type ReceivedAssignmentDocument = Pick<ReceivedDocumentDetail, 'id' | 'companyId' | 'branchId'>;
const assignmentUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function canAssignReceivedDocument(user: User | undefined, permission: boolean) {
  return !!user && permission && user.scope.kind === 'GLOBAL' && user.roles.includes('ADMIN');
}
export function receivedAssignmentBranches(companyId: number, branches: readonly Branch[] = []) {
  return branches.filter(branch => branch.companyId === companyId && assignmentUuid(branch.id));
}
export function receivedAssignmentCommand(detail: ReceivedAssignmentDocument, branchId: string | null, branches: readonly Branch[]) {
  if (detail.branchId !== null && !assignmentUuid(detail.branchId)) throw new Error('La sede actual del documento es inválida. Actualiza el detalle.');
  if (branchId !== null && (!assignmentUuid(branchId) || !receivedAssignmentBranches(detail.companyId, branches).some(branch => branch.id === branchId))) throw new Error('Selecciona una sede del catálogo actual de la empresa receptora.');
  return { branchId, expectedBranchId: detail.branchId };
}
export async function saveReceivedAssignment(api: <T>(path: string, options?: RequestInit) => Promise<T>, detail: ReceivedAssignmentDocument, branchId: string | null, branches: readonly Branch[], signal: AbortSignal) {
  signal.throwIfAborted();
  const body = receivedAssignmentCommand(detail, branchId, branches);
  let value: unknown;
  try {
    value = await api<unknown>(`${RECEIVED_API}/${encodeURIComponent(detail.id)}/assignment`, { method: 'PATCH', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), body: JSON.stringify(body) });
  } catch (reason) {
    signal.throwIfAborted();
    if (reason instanceof ApiError && reason.status === 409) throw new ApiError('La sede cambió en otra sesión. Conservamos tu selección; usa Cargar sede actual antes de volver a guardar.', 409);
    throw new Error('No se pudo guardar la sede. Comprueba permisos y disponibilidad del servicio.');
  }
  signal.throwIfAborted();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'branchId') ||
    (value as { branchId?: unknown }).branchId !== branchId) throw new Error('La respuesta de asignación es inválida. Actualiza el detalle para comprobar la sede.');
  return { branchId };
}

export function ReceivedAssignmentForm({ detail, branchId, expectedBranchId = detail.branchId, busy = false, blocked = false, conflict = false, onChange, onSubmit, onReset }: {
  detail: Pick<ReceivedDocumentDetail, 'companyId' | 'recipientRuc' | 'branchId'>; branchId: string | null; expectedBranchId?: string | null;
  busy?: boolean; blocked?: boolean; conflict?: boolean; onChange: (branchId: string | null) => void; onSubmit: () => void; onReset?: () => void;
}) {
  const { user, can, catalog, catalogError } = useWorkspace();
  const id = useId();
  if (!canAssignReceivedDocument(user, can('setup.manage'))) return null;
  const branches = receivedAssignmentBranches(detail.companyId, catalog?.branches);
  const current = branches.find(branch => branch.id === branchId);
  const changed = branchId !== expectedBranchId;
  const stale = conflict || expectedBranchId !== detail.branchId;
  const invalid = branchId !== null && !current;
  const unavailable = !catalog || !!catalogError;
  const disabled = busy || blocked || unavailable;
  return <Card className="shadow-none"><CardHeader><CardTitle>Asignación manual de sede</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">El RUC identifica la empresa receptora, pero no identifica la sede en recepción. Los documentos automáticos sin sede se consultan como administrador general con el filtro Todas las sedes; la sede se asigna manualmente.</p>
    <p className="text-xs text-muted-foreground">RUC receptor: {detail.recipientRuc}. Esta asignación es administrativa; no cambia el RUC, el XML, su proyección ni el estado fiscal.</p>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!disabled && changed && !stale && !invalid) onSubmit(); }}>
      <div className="space-y-2"><Label htmlFor={id}>Sede receptora</Label><Select value={branchId ?? 'UNASSIGNED'} disabled={disabled} onValueChange={value => onChange(value === 'UNASSIGNED' ? null : value)}>
        <SelectTrigger id={id} className="w-full" aria-describedby={`${id}-help`}><SelectValue>{branchId === null ? 'Sin asignar' : current ? `${current.code} · ${current.name}` : 'Sede fuera del catálogo actual'}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="UNASSIGNED">Sin asignar</SelectItem>{branches.map(branch => <SelectItem key={branch.id} value={branch.id}>{branch.code} · {branch.name}</SelectItem>)}</SelectContent>
      </Select></div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">Sólo sedes del catálogo actual de esta empresa. Sin asignar conserva o restablece la sede vacía; no se deduce una sede del RUC.</p>
      {unavailable && <p className="text-sm">El catálogo de sedes no está disponible. Actualiza el catálogo antes de guardar.</p>}
      {invalid && <p className="text-sm">La selección no pertenece al catálogo actual de esta empresa.</p>}
      {stale && <p className="text-sm">La sede actual cambió. Tu selección se conserva; carga la sede actual antes de volver a guardar.</p>}
      {blocked && <p className="text-sm">Guarda los cambios de registro o quita el archivo seleccionado antes de guardar la sede.</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !changed || stale || invalid}>{busy ? 'Procesando…' : 'Guardar sede'}</Button>
        {onReset && <Button type="button" variant="outline" disabled={busy || !changed && !stale} onClick={onReset}>Cargar sede actual</Button>}</div>
    </form>
  </CardContent></Card>;
}

function ReceivedDetail({ detail, reload }: { detail: ReceivedDocumentDetail; reload: () => void }) {
  const { api, apiBlob, can, user, catalog, catalogError, setDirty } = useWorkspace();
  const action = useReceivedAction();
  const canManage = can('setup.manage');
  const canAssign = canAssignReceivedDocument(user, canManage);
  const [registered, setRegistered] = useState(!!detail.registeredAt);
  const [erpReference, setErpReference] = useState(detail.erpReference ?? '');
  const [artifactKind, setArtifactKind] = useState<Exclude<ReceivedFileKind, 'UPLOAD'>>('PROVIDER_PDF');
  const [file, setFile] = useState<File>();
  // Pin the CAS value from the detail that initialized this form, even after live reads.
  const [assignmentBase, setAssignmentBase] = useState<ReceivedAssignmentDocument>(() => ({ id: detail.id, companyId: detail.companyId, branchId: detail.branchId }));
  const [assignmentBranchId, setAssignmentBranchId] = useState<string | null>(detail.branchId);
  const [assignmentConflict, setAssignmentConflict] = useState(false);
  const assignmentChanged = canAssign && assignmentBranchId !== assignmentBase.branchId;
  const changed = registered !== !!detail.registeredAt || registered && erpReference !== (detail.erpReference ?? '');
  const fileError = file ? receivedFileError([file], artifactKind) : undefined;
  const dirty = canManage && (changed || !!file) || assignmentChanged || !!action.busy;
  useEffect(() => { setDirty(dirty); }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);
  async function assignment() {
    if (!canAssign || !catalog || catalogError || !assignmentChanged || action.busy || changed || file || assignmentConflict || assignmentBase.branchId !== detail.branchId) return;
    await action.run('assignment', async signal => {
      try { return await saveReceivedAssignment(api, assignmentBase, assignmentBranchId, catalog.branches, signal); }
      catch (reason) { if (!signal.aborted && reason instanceof ApiError && reason.status === 409) setAssignmentConflict(true); throw reason; }
    }, value => {
      setAssignmentBase(current => ({ ...current, branchId: value.branchId })); setAssignmentBranchId(value.branchId); setAssignmentConflict(false); reload();
    });
  }
  function resetAssignment() {
    action.setError(undefined);
    setAssignmentBase({ id: detail.id, companyId: detail.companyId, branchId: detail.branchId }); setAssignmentBranchId(detail.branchId);
    setAssignmentConflict(false);
    if (assignmentConflict && !changed && !file) reload();
  }
  async function registration(event: FormEvent) {
    event.preventDefault();
    if (!canManage || action.busy || !changed || assignmentChanged) return;
    await action.run('registration', signal => api(`${RECEIVED_API}/${encodeURIComponent(detail.id)}/registration`, { method: 'PATCH', signal, body: JSON.stringify(receivedRegistration(registered, erpReference)) }), reload);
  }
  async function attach(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !file || fileError || action.busy || assignmentChanged) return;
    await action.run('attach', async signal => {
      const [encoded] = await readReceivedFiles([file], artifactKind, signal);
      signal.throwIfAborted();
      return api(`${RECEIVED_API}/${encodeURIComponent(detail.id)}/artifacts`, { method: 'POST', signal, body: JSON.stringify({ kind: artifactKind, ...encoded }) });
    }, () => { setFile(undefined); reload(); });
  }
  async function download(artifact?: ReceivedDocumentDetail['artifacts'][number]) {
    if (action.busy) return;
    const path = `${RECEIVED_API}/${encodeURIComponent(detail.id)}${artifact ? `/artifacts/${encodeURIComponent(artifact.id)}` : '/pdf'}`;
    const mediaType = !artifact || artifact.kind === 'PROVIDER_PDF' ? 'application/pdf' : /\.zip$/i.test(artifact.fileName) ? 'application/zip' : 'application/xml';
    await action.run(artifact?.id ?? 'pdf', signal => apiBlob(path, signal, mediaType), blob => saveReceivedBlob(blob,
      artifact?.fileName ?? `${detail.recipientRuc}-${detail.fullNumber}-COPIA-NO-FISCAL.pdf`));
  }
  return <>
    <BackToReceived />
    <PageHeading eyebrow="Documento recibido" title={detail.fullNumber} description={RECEIVED_NOTICE} action={<Button variant="outline" disabled={!!action.busy || changed || !!file || assignmentChanged} onClick={reload}><RefreshCw className="size-4" />Actualizar</Button>} />
    <div className="space-y-5">
      {action.error && <ErrorState message={action.error} />}
      {canAssign && <ReceivedAssignmentForm detail={detail} branchId={assignmentBranchId} expectedBranchId={assignmentBase.branchId} busy={!!action.busy} blocked={!!changed || !!file} conflict={assignmentConflict} onChange={setAssignmentBranchId} onSubmit={() => void assignment()} onReset={resetAssignment} />}
      <ReceivedProjection detail={detail} />
      <ReceivedArtifacts detail={detail} busy={action.busy} onDownload={artifact => void download(artifact)} onGenerated={() => void download()} />
      <Card className="shadow-none"><CardHeader><CardTitle>Registro interno / ERP</CardTitle></CardHeader><CardContent className="space-y-3">
        <p className="text-sm">{detail.registeredAt ? `Registrado: ${detail.registeredAt}` : 'Pendiente de registro'}{detail.erpReference ? ` · Referencia ERP: ${detail.erpReference}` : ''}</p>
        <p className="text-xs text-muted-foreground">Esta marca es administrativa y no cambia el estado SUNAT.</p>
        {canManage && <form onSubmit={registration} className="space-y-3">
          <Label className="flex items-center gap-2"><input type="checkbox" checked={registered} disabled={!!action.busy} onChange={event => setRegistered(event.target.checked)} />Registrado internamente</Label>
          <div><Label htmlFor="received-erp">Referencia contable o ERP (requerida al registrar)</Label><Input id="received-erp" value={erpReference} disabled={!registered || !!action.busy} maxLength={150} onChange={event => setErpReference(event.target.value)} /></div>
          <Button type="submit" disabled={!changed || !!action.busy || assignmentChanged}>{action.busy === 'registration' ? 'Guardando…' : 'Guardar registro'}</Button>
        </form>}
      </CardContent></Card>
      {canManage && <Card className="shadow-none"><CardHeader><CardTitle>Adjuntar un original</CardTitle></CardHeader><CardContent><form onSubmit={attach} className="space-y-3">
        <p className="text-xs text-muted-foreground">Hasta 4 MiB. Adjuntar un CDR no acredita aceptación fiscal.</p>
        <div><Label htmlFor="received-artifact-kind">Tipo de original</Label><Select disabled={!!action.busy} value={artifactKind} onValueChange={value => { setArtifactKind(value as typeof artifactKind); setFile(undefined); }}><SelectTrigger id="received-artifact-kind"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PROVIDER_PDF">PDF original del proveedor</SelectItem><SelectItem value="CDR">CDR XML o ZIP (un solo CDR)</SelectItem></SelectContent></Select></div>
        <div><Label htmlFor="received-original">Archivo original</Label><Input key={artifactKind} id="received-original" type="file" accept={artifactKind === 'PROVIDER_PDF' ? '.pdf' : '.xml,.zip'} disabled={!!action.busy} onChange={event => { setFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
        {file && <p className="text-xs">{file.name} · {file.size} bytes</p>}{fileError && <ErrorState message={fileError} />}
        <Button type="submit" disabled={!file || !!fileError || !!action.busy || assignmentChanged}>{action.busy === 'attach' ? 'Adjuntando…' : 'Adjuntar original'}</Button>
        {file && <Button type="button" variant="outline" className="ml-2" disabled={!!action.busy} onClick={() => setFile(undefined)}>Quitar selección</Button>}
      </form></CardContent></Card>}
    </div>
  </>;
}
