"use client";
import { useEffect, useState } from 'react';
import { Button } from '@factuez/ui/components/button';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Checkbox } from '@factuez/ui/components/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@factuez/ui/components/table';
import { Badge } from '@factuez/ui/components/badge';
import { ErrorState, Loading, money } from './common';
import { ListPagination, pageWindow } from './list-pagination';
import { useResource, useWorkspace } from './provider';
type Product = { id: string; sku: string; description: string; category: string; sunatProductCode: string | null; unitCode: string; taxAffectationCode: string; defaultUnitPrice: string | null; active: boolean; updatedAt: string };
const blank = () => ({ sku: '', description: '', category: '', sunatProductCode: '', unitCode: 'GLL', taxAffectationCode: '10', defaultUnitPrice: '', active: true });
export function ProductAdmin() {
  const { api, reloadCatalog, setDirty } = useWorkspace();
  const resource = useResource<Product[]>('/api/v1/stations/products');
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
  const [target, setTarget] = useState<Product>(); const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank()); const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>();
  useEffect(() => { setDirty(open && changed); return () => setDirty(false); }, [open, changed, setDirty]);
  useEffect(() => setPage(1), [search]);
  function edit(product?: Product) { setTarget(product); setForm(product ? { ...product, sunatProductCode: product.sunatProductCode ?? '', defaultUnitPrice: product.defaultUnitPrice ?? '' } : blank()); setChanged(false); setError(undefined); setOpen(true); }
  async function save() {
    if (busy) return; setBusy(true); setError(undefined);
    try {
      const body = { ...form, sunatProductCode: form.sunatProductCode || null, defaultUnitPrice: form.defaultUnitPrice || null, ...(target ? { expectedUpdatedAt: target.updatedAt } : {}) };
      // El formulario no envía IDs, fechas ni propiedades ajenas al contrato.
      const { sku, description, category, sunatProductCode, unitCode, taxAffectationCode, defaultUnitPrice, active } = body;
      await api(`/api/v1/stations/products${target ? `/${target.id}` : ''}`, { method: target ? 'PATCH' : 'POST', body: JSON.stringify({ sku, description, category, sunatProductCode, unitCode, taxAffectationCode, defaultUnitPrice, active, ...(target ? { expectedUpdatedAt: target.updatedAt } : {}) }) });
      setOpen(false); setChanged(false); resource.reload(); await reloadCatalog(); setNotice('Catálogo actualizado. Los comprobantes anteriores conservan sus datos originales.');
    } catch (error) { setError(error instanceof Error ? error.message : 'No se pudo guardar el producto'); }
    finally { setBusy(false); }
  }
  const rows = resource.data?.filter(row => `${row.sku} ${row.description} ${row.category}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const window = pageWindow(rows.length, page);
  return <Card><CardHeader className="flex-row flex-wrap items-start justify-between gap-3"><div><CardTitle>Combustibles y productos</CardTitle><CardDescription className="mt-2">Catálogo compartido. Desactivar impide nuevas selecciones, sin borrar el historial.</CardDescription></div><Button onClick={() => edit()}>Nuevo producto</Button></CardHeader><CardContent className="space-y-4">{notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}<Input aria-label="Buscar productos" placeholder="Buscar SKU, descripción o categoría" value={search} onChange={event => setSearch(event.target.value)} className="max-w-md" />{resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !resource.data ? <Loading /> : <><Table><TableHeader><TableRow><TableHead>SKU / producto</TableHead><TableHead>Unidad / IGV</TableHead><TableHead>Precio</TableHead><TableHead>Estado</TableHead><TableHead>Acciones</TableHead></TableRow></TableHeader><TableBody>{rows.slice(window.start, window.end).map(product => <TableRow key={product.id}><TableCell><p className="font-medium">{product.description}</p><p className="text-xs text-muted-foreground">{product.sku} · {product.category}</p></TableCell><TableCell>{product.unitCode} · {product.taxAffectationCode}</TableCell><TableCell>{product.defaultUnitPrice === null ? 'Sin precio' : money(product.defaultUnitPrice)}</TableCell><TableCell><Badge variant="outline">{product.active ? 'Activo' : 'Inactivo'}</Badge></TableCell><TableCell><Button size="sm" variant="outline" onClick={() => edit(product)}>Editar / estado</Button></TableCell></TableRow>)}</TableBody></Table><ListPagination total={rows.length} page={page} onChange={setPage} /></>}
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{target ? 'Editar producto' : 'Nuevo producto'}</DialogTitle><DialogDescription>Los precios y descripciones nuevos sólo se usan en operaciones futuras. No se modifican XML ni ventas anteriores.</DialogDescription></DialogHeader><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">{([['sku', 'SKU'], ['description', 'Descripción'], ['category', 'Categoría'], ['sunatProductCode', 'Código SUNAT (8 dígitos, opcional)'], ['unitCode', 'Unidad de medida (3 caracteres)'], ['taxAffectationCode', 'Código de afectación IGV'], ['defaultUnitPrice', 'Precio de referencia (opcional)']] as const).map(([key, label]) => <div className={key === 'description' ? 'space-y-2 sm:col-span-2' : 'space-y-2'} key={key}><Label htmlFor={`product-${key}`}>{label}</Label><Input id={`product-${key}`} value={form[key]} onChange={event => { setForm(current => ({ ...current, [key]: event.target.value })); setChanged(true); }} /></div>)}<label className="flex items-center gap-3 text-sm"><Checkbox checked={form.active} onCheckedChange={value => { setForm(current => ({ ...current, active: value === true })); setChanged(true); }} />Producto activo</label></fieldset>{error && <ErrorState message={error} />}<DialogFooter><Button disabled={busy} variant="outline" onClick={() => setOpen(false)}>Cancelar</Button><Button disabled={busy || !form.sku || !form.description || !form.category} onClick={() => void save()}>Guardar producto</Button></DialogFooter></DialogContent></Dialog>
  </CardContent></Card>;
}
