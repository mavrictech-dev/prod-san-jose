'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, LoaderCircle, LogOut, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { BrandHeader } from './brand-header';

type Product = { id: string; sku: string; description: string; unitCode: string; taxAffectationCode: string; defaultUnitPrice: string | null };
type EmissionPoint = { id: string; code: string; name: string; trackNumber: number | null; series: Array<{ documentType: 'SALES_RECEIPT' | 'INVOICE'; series: string }> };
type Catalog = { company: { legalName: string; ruc: string; environment: string }; emissionPoints: EmissionPoint[]; products: Product[] };
type RecentDocument = { id: string; fullNumber: string; documentType: string; customerLegalName: string; payableAmount: string; sunatStatus: string; issueDate: string; sunatResponseDescription?: string | null };
type Session = { accessToken: string; username: string };
type Line = { id: string; productId: string; quantity: number; unitPrice: number };

// Las rutas del backend ya comienzan con /api/v1. En la intranet, Kong y la
// PWA comparten el mismo origen, por lo que no debe añadirse otro /api.
const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');
const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });

function statusLabel(status: string) {
  return ({ QUEUED: 'En cola', PROCESSING: 'Procesando', BUILDING: 'UBL construido', ACCEPTED: 'Aceptado', REJECTED: 'Rechazado', RETRYABLE_ERROR: 'Reintentar' } as Record<string, string>)[status] ?? status;
}

async function api<T>(path: string, token?: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string | string[] } | null;
    const message = Array.isArray(body?.message) ? body?.message.join(', ') : body?.message;
    throw new Error(message ?? `Error ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function BrandLogin({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError(undefined);
    try {
      const result = await api<{ accessToken: string }>('/api/v1/auth/login', undefined, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      onAuthenticated({ accessToken: result.accessToken, username });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No fue posible iniciar sesión'); }
    finally { setLoading(false); }
  }
  return <main className="min-h-screen bg-[var(--background)] px-4 py-4 sm:px-6 lg:px-8"><div className="mx-auto max-w-6xl"><BrandHeader /><section className="mx-auto mt-14 max-w-sm rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 shadow-sm"><h1 className="text-base font-semibold">Ingresar a terminal</h1><p className="mt-1 text-xs text-[var(--muted)]">Use la cuenta asignada por el administrador de Grifo San José.</p><form className="mt-5 space-y-3" onSubmit={submit}><label className="grid gap-1 text-xs font-medium text-[var(--muted)]">Usuario<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]" /></label><label className="grid gap-1 text-xs font-medium text-[var(--muted)]">Contraseña<input autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]" /></label>{error && <p role="alert" className="rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-400">{error}</p>}<button disabled={loading} className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-zinc-900 text-xs font-semibold text-white disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900">{loading && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Ingresar</button></form></section></div></main>;
}

export function AuthenticatedTerminal() {
  const [session, setSession] = useState<Session>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [documents, setDocuments] = useState<RecentDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function reload(token = session?.accessToken) {
    if (!token) return;
    setLoading(true); setError(undefined);
    try {
      const [nextCatalog, nextDocuments] = await Promise.all([
        api<Catalog>('/api/v1/documents/catalog/issuance', token), api<RecentDocument[]>('/api/v1/documents', token),
      ]);
      setCatalog(nextCatalog); setDocuments(nextDocuments);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No fue posible cargar la terminal'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (session) void reload(session.accessToken); }, [session]);
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => void reload(), 2_500);
    return () => window.clearInterval(timer);
  }, [session]);

  if (!session) return <BrandLogin onAuthenticated={setSession} />;
  return <main className="min-h-screen bg-[var(--background)] px-4 py-4 sm:px-6 lg:px-8"><div className="mx-auto max-w-6xl"><BrandHeader /><div className="mb-4 flex items-center justify-between text-xs"><span className="text-[var(--muted)]">Operador: <strong className="text-[var(--foreground)]">{session.username}</strong>{catalog && <> · {catalog.company.legalName} · <span className="font-mono">{catalog.company.environment}</span></>}</span><button onClick={() => { setSession(undefined); setCatalog(undefined); setDocuments([]); }} className="inline-flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"><LogOut className="h-3.5 w-3.5" />Cerrar sesión</button></div>{error && <div role="alert" className="mb-4 flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400"><XCircle className="h-4 w-4" />{error}</div>}{loading && !catalog ? <div className="grid min-h-60 place-items-center text-sm text-[var(--muted)]"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />Cargando terminal…</div> : catalog ? <IssuanceTerminal catalog={catalog} token={session.accessToken} documents={documents} onIssued={() => void reload()} /> : <button onClick={() => void reload()} className="rounded border border-[var(--border)] px-3 py-2 text-xs">Reintentar carga</button>}</div></main>;
}

function IssuanceTerminal({ catalog, token, documents, onIssued }: { catalog: Catalog; token: string; documents: RecentDocument[]; onIssued: () => void }) {
  const [pointId, setPointId] = useState(catalog.emissionPoints[0]?.id ?? '');
  const [documentType, setDocumentType] = useState<'SALES_RECEIPT' | 'INVOICE'>('SALES_RECEIPT');
  const [customerDocument, setCustomerDocument] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [lines, setLines] = useState<Line[]>(() => catalog.products[0] ? [{ id: crypto.randomUUID(), productId: catalog.products[0].id, quantity: 1, unitPrice: Number(catalog.products[0].defaultUnitPrice ?? 0) }] : []);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const point = catalog.emissionPoints.find((entry) => entry.id === pointId);
  const series = point?.series.find((entry) => entry.documentType === documentType)?.series;
  const total = useMemo(() => lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0), [lines]);
  const taxable = total / 1.18; const igv = total - taxable;
  function updateLine(id: string, patch: Partial<Line>) { setLines((items) => items.map((line) => line.id === id ? { ...line, ...patch } : line)); }
  function selectProduct(id: string, productId: string) { const product = catalog.products.find((entry) => entry.id === productId); if (product) updateLine(id, { productId, unitPrice: Number(product.defaultUnitPrice ?? 0) }); }
  async function issue() {
    setError(undefined); setNotice(undefined);
    if (!pointId || !series || !lines.length) { setError('Falta configurar punto de emisión, serie o producto.'); return; }
    if (documentType === 'INVOICE' && customerDocument.trim().length !== 11) { setError('Una factura requiere RUC de 11 dígitos.'); return; }
    if (lines.some((line) => !catalog.products.some((product) => product.id === line.productId) || line.quantity <= 0 || line.unitPrice <= 0)) { setError('Revise producto, cantidad y precio de cada ítem.'); return; }
    setSending(true);
    try {
      const result = await api<{ documentId: string; fullNumber: string; sunatStatus: string }>('/api/v1/documents', token, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          emissionPointId: pointId, documentType, series, currencyCode: 'PEN',
          customer: { identityType: documentType === 'INVOICE' ? '6' : customerDocument.trim() ? '1' : '0', identityNumber: customerDocument.trim() || '0', legalName: customerName.trim() || 'CONSUMIDOR FINAL' },
          lines: lines.map((line) => { const product = catalog.products.find((entry) => entry.id === line.productId)!; return { productId: product.id, productCode: product.sku, description: product.description, unitCode: product.unitCode, quantity: line.quantity.toFixed(3), unitPriceWithTax: line.unitPrice.toFixed(6), taxAffectationCode: product.taxAffectationCode, igvRate: '18.00' }; }),
        }),
      });
      setNotice(`${result.fullNumber} fue emitido localmente y quedó ${statusLabel(result.sunatStatus)}.`); onIssued();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No fue posible emitir el comprobante'); }
    finally { setSending(false); }
  }
  return <><section className="grid gap-5 lg:grid-cols-3"><div className="space-y-4 lg:col-span-2"><div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 shadow-sm"><h1 className="text-sm font-semibold">Datos del comprobante</h1><div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="grid gap-1 text-xs font-medium text-[var(--muted)]">Tipo<select className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs" value={documentType} onChange={(event) => setDocumentType(event.target.value as 'SALES_RECEIPT' | 'INVOICE')}><option value="SALES_RECEIPT">Boleta electrónica</option><option value="INVOICE">Factura electrónica</option></select></label><label className="grid gap-1 text-xs font-medium text-[var(--muted)]">Pista / punto<select className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs" value={pointId} onChange={(event) => setPointId(event.target.value)}>{catalog.emissionPoints.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} · {entry.name}</option>)}</select></label><label className="grid gap-1 text-xs font-medium text-[var(--muted)]">Serie<input readOnly className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-xs" value={series ?? 'Sin serie'} /></label></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-medium text-[var(--muted)]">{documentType === 'INVOICE' ? 'RUC cliente' : 'DNI / documento'}<input className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 font-mono text-xs" value={customerDocument} onChange={(event) => setCustomerDocument(event.target.value)} placeholder={documentType === 'INVOICE' ? '20XXXXXXXXX' : 'Opcional'} /></label><label className="grid gap-1 text-xs font-medium text-[var(--muted)]">Razón social / nombres<input className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Consumidor final" /></label></div></div><div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Detalle del despacho</h2><p className="mt-1 text-xs text-[var(--muted)]">Catálogo de combustible de prueba.</p></div><button onClick={() => catalog.products[0] && setLines((current) => [...current, { id: crypto.randomUUID(), productId: catalog.products[0].id, quantity: 1, unitPrice: Number(catalog.products[0].defaultUnitPrice ?? 0) }])} className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs font-medium hover:bg-[var(--surface)]"><Plus className="h-3.5 w-3.5" />Agregar ítem</button></div><div className="mt-4 space-y-2">{lines.map((line) => <div className="grid grid-cols-12 items-center gap-2" key={line.id}><select aria-label="Producto" className="col-span-5 h-8 min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-xs" value={line.productId} onChange={(event) => selectProduct(line.id, event.target.value)}>{catalog.products.map((product) => <option value={product.id} key={product.id}>{product.description} ({product.unitCode})</option>)}</select><input aria-label="Cantidad" className="col-span-2 h-8 min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-right font-mono text-xs" type="number" min="0" step="0.001" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) || 0 })} /><input aria-label="Precio unitario" className="col-span-2 h-8 min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-right font-mono text-xs" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(line.id, { unitPrice: Number(event.target.value) || 0 })} /><span className="col-span-2 text-right font-mono text-xs font-semibold">{money.format(line.quantity * line.unitPrice)}</span><button aria-label="Quitar ítem" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((entry) => entry.id !== line.id))} className="col-span-1 justify-self-center text-[var(--muted)] enabled:hover:text-red-600 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button></div>)}</div></div></div><aside className="space-y-4"><div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"><h2 className="text-sm font-semibold">Liquidación</h2><dl className="mt-4 space-y-2 text-xs"><div className="flex justify-between text-[var(--muted)]"><dt>Operación gravada</dt><dd className="font-mono">{money.format(taxable)}</dd></div><div className="flex justify-between text-[var(--muted)]"><dt>IGV (18%)</dt><dd className="font-mono">{money.format(igv)}</dd></div><div className="mt-3 flex items-baseline justify-between border-t border-[var(--border)] pt-3"><dt className="text-sm font-semibold">Total a pagar</dt><dd className="font-mono text-xl font-bold">{money.format(total)}</dd></div></dl></div><button disabled={sending || !catalog.products.length} onClick={() => void issue()} className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-zinc-900 text-xs font-semibold text-white disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900">{sending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}Emitir en Beta</button><p className="text-[11px] text-[var(--muted)]">No firma ni transmite a SUNAT. Genera UBL de prueba y lo deja en procesamiento.</p></aside></section>{notice && <div className="mt-4 flex items-center gap-2 rounded border border-emerald-600/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />{notice}</div>}{error && <div role="alert" className="mt-4 flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400"><XCircle className="h-4 w-4" />{error}</div>}<RecentDocuments documents={documents} /></>;
}

function RecentDocuments({ documents }: { documents: RecentDocument[] }) {
  return <section className="mt-6"><h2 className="text-sm font-semibold">Comprobantes recientes</h2><p className="mb-3 mt-1 text-xs text-[var(--muted)]">Consulta automática del estado interno cada 2.5 segundos.</p><div className="overflow-x-auto rounded-lg border border-[var(--border)]"><div className="min-w-[680px] text-xs"><div className="grid grid-cols-12 border-b border-[var(--border)] bg-[var(--surface)] p-3 font-medium text-[var(--muted)]"><span className="col-span-3">Comprobante</span><span className="col-span-3">Cliente</span><span className="col-span-2 text-right">Monto</span><span className="col-span-2 text-center">Estado</span><span className="col-span-2 text-right">Emisión</span></div>{documents.length ? documents.map((document) => <div className="grid grid-cols-12 items-center border-b border-[var(--border)] p-3 last:border-0" key={document.id}><span className="col-span-3 font-mono font-semibold">{document.fullNumber}<small className="mt-0.5 block font-sans font-normal text-[var(--muted)]">{document.documentType === 'INVOICE' ? 'Factura' : 'Boleta'}</small></span><span className="col-span-3 truncate">{document.customerLegalName}</span><span className="col-span-2 text-right font-mono">{money.format(Number(document.payableAmount))}</span><span className="col-span-2 justify-self-center rounded-full border border-emerald-600/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">{statusLabel(document.sunatStatus)}</span><time className="col-span-2 text-right text-[var(--muted)]">{new Date(document.issueDate).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}</time></div>) : <p className="p-4 text-[var(--muted)]">Aún no hay comprobantes emitidos en esta prueba.</p>}</div></div></section>;
}
