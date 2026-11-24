"use client";
import {GRE_GOODS_FAMILIES} from '@factuez/contracts/production-guides';
import {TAX_TREATMENTS,type TaxPolicyView} from '@factuez/contracts';
import {choiceClass} from './tax-policy-admin';
import type {CategoryMaster,UnitMaster} from './product-masters';
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
import { ApiError, useResource, useWorkspace } from './provider';
type Product = { greGoodsFamily:string; id: string; sku: string; description: string; category: string; categoryId:string; sunatProductCode: string | null; unitCode: string; taxAffectationCode: string; defaultUnitPrice: string | null; active: boolean; updatedAt: string };
const blank = () => ({greGoodsFamily:'UNCLASSIFIED', sku: '', description: '', categoryId: '', sunatProductCode: '', unitCode: 'GLL', taxAffectationCode: '10', defaultUnitPrice: '', active: true });
export function ProductAdmin() {
  const { api, reloadCatalog, setDirty, companyId, branchId } = useWorkspace();
  const resource = useResource<Product[]>('/api/v1/stations/products');
  const categories=useResource<CategoryMaster[]>('/api/v1/stations/product-categories');
  const units=useResource<UnitMaster[]>('/api/v1/stations/product-units');
  const policy=useResource<TaxPolicyView>(companyId?`/api/v1/stations/companies/${companyId}/tax-policy${branchId?`?branchId=${branchId}`:''}`:undefined);
  const assignments=useResource<Array<{productId:string;branchId:string|null;treatment:string;overridden:boolean}>>(companyId?`/api/v1/stations/companies/${companyId}/product-taxes${branchId?`?branchId=${branchId}`:''}`:undefined);
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
  const [target, setTarget] = useState<Product>(); const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank()); const [changed, setChanged] = useState(false);
  const [fieldErrors,setFieldErrors]=useState<Record<string,string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>();
  useEffect(() => { setDirty(open && changed); return () => setDirty(false); }, [open, changed, setDirty]);
  useEffect(() => setPage(1), [search]);
  function edit(product?: Product) { setTarget(product); setForm(product ? { ...product, sunatProductCode: product.sunatProductCode ?? '', defaultUnitPrice: product.defaultUnitPrice ?? '' } : blank()); setChanged(false);setFieldErrors({}); setError(undefined); setOpen(true); }
  async function save() {
    if (busy) return; setBusy(true); setError(undefined);
    try {
      const body = { ...form, sunatProductCode: form.sunatProductCode || null, defaultUnitPrice: form.defaultUnitPrice || null, ...(target ? { expectedUpdatedAt: target.updatedAt } : {}) };
      // El formulario no envía IDs, fechas ni propiedades ajenas al contrato.
      const { greGoodsFamily,sku, description, categoryId, sunatProductCode, unitCode, taxAffectationCode, defaultUnitPrice, active } = body;
      await api(`/api/v1/stations/products${target ? `/${target.id}` : ''}`, { method: target ? 'PATCH' : 'POST', body: JSON.stringify({ greGoodsFamily,sku, description, categoryId, sunatProductCode, unitCode, taxAffectationCode: '10', defaultUnitPrice, active, ...(target ? { expectedUpdatedAt: target.updatedAt } : {}) }) });
      setOpen(false); setChanged(false); resource.reload(); await reloadCatalog(); setNotice('Catálogo actualizado. Los comprobantes anteriores conservan sus datos originales.');
    } catch (error) {if(error instanceof ApiError)setFieldErrors(error.fieldErrors??{}); setError(error instanceof Error ? error.message : 'No se pudo guardar el producto'); }
    finally { setBusy(false); }
  }
  function treatmentFor(productId?:string){const assigned=assignments.data?.filter(a=>a.productId===productId&&a.overridden);return assigned?.find(a=>a.branchId===(branchId||null))?.treatment??assigned?.find(a=>a.branchId===null)?.treatment??policy.data?.policy.defaultTreatment??'10';}
  const effectiveTreatment=treatmentFor(target?.id);
  function taxCaption(productId:string){if(!companyId)return 'Según RUC y sede';if(!policy.data||!assignments.data)return 'Consultar política';const code=treatmentFor(productId);return `${TAX_TREATMENTS.find(t=>t.code===code)?.label??code} · ${code==='10'?policy.data.policy.rate:'0'} %`;}
  const rows = resource.data?.filter(row => `${row.sku} ${row.description} ${row.category}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const window = pageWindow(rows.length, page);
  return <Card><CardHeader className="flex-row flex-wrap items-start justify-between gap-3"><div><CardTitle>Combustibles y productos</CardTitle><CardDescription className="mt-2">Catálogo compartido. Desactivar impide nuevas selecciones, sin borrar el historial.</CardDescription></div><Button onClick={() => edit()}>Nuevo producto</Button></CardHeader><CardContent className="space-y-4">{notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}<Input aria-label="Buscar productos" placeholder="Buscar SKU, descripción o categoría" value={search} onChange={event => setSearch(event.target.value)} className="max-w-md" />{resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !resource.data ? <Loading /> : <><Table><TableHeader><TableRow><TableHead>SKU / producto</TableHead><TableHead>Unidad / IGV</TableHead><TableHead>Precio</TableHead><TableHead>Estado</TableHead><TableHead>Acciones</TableHead></TableRow></TableHeader><TableBody>{rows.slice(window.start, window.end).map(product => <TableRow key={product.id}><TableCell><p className="font-medium">{product.description}</p><p className="text-xs text-muted-foreground">{product.sku} · {product.category}</p></TableCell><TableCell>{product.unitCode} · {taxCaption(product.id)}</TableCell><TableCell>{product.defaultUnitPrice === null ? 'Sin precio' : money(product.defaultUnitPrice)}</TableCell><TableCell><Badge variant="outline">{product.active ? 'Activo' : 'Inactivo'}</Badge></TableCell><TableCell><Button size="sm" variant="outline" onClick={() => edit(product)}>Editar / estado</Button></TableCell></TableRow>)}</TableBody></Table><ListPagination total={rows.length} page={page} onChange={setPage} /></>}
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{target ? 'Editar producto' : 'Nuevo producto'}</DialogTitle><DialogDescription>Los precios y descripciones nuevos sólo se usan en operaciones futuras. No se modifican XML ni ventas anteriores.</DialogDescription></DialogHeader><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">{([['sku', 'SKU'], ['description', 'Descripción'], ['sunatProductCode', 'Código SUNAT (8 dígitos, opcional)'], ['defaultUnitPrice', 'Precio de referencia (opcional)']] as const).map(([key, label]) => <div className={key === 'description' ? 'space-y-2 sm:col-span-2' : 'space-y-2'} key={key}><Label htmlFor={`product-${key}`}>{label}</Label><Input aria-invalid={!!fieldErrors[key]} aria-describedby={fieldErrors[key]?`product-${key}-error`:undefined} id={`product-${key}`} value={form[key]} onChange={event => { setForm(current => ({ ...current, [key]: event.target.value })); setChanged(true); }} />{fieldErrors[key]&&<p id={`product-${key}-error`} role="alert" className="text-sm text-destructive">{fieldErrors[key]}</p>}</div>)}<div className="space-y-2"><Label htmlFor="product-gre-family">Familia para traslado GRE</Label><select id="product-gre-family" className={choiceClass} value={form.greGoodsFamily} onChange={e=>{setForm(v=>({...v,greGoodsFamily:e.target.value}));setChanged(true);}}>{GRE_GOODS_FAMILIES.map(f=><option key={f} value={f}>{f}</option>)}</select><p className="text-xs">Pendiente: UNCLASSIFIED. GNV requiere definir estaci?n o transporte m?vil.</p></div><div className="space-y-2"><Label htmlFor="product-category">Categoría</Label><select id="product-category" className={choiceClass} value={form.categoryId} onChange={event=>{setForm(current=>({...current,categoryId:event.target.value}));setChanged(true);}}><option value="">Seleccione categoría</option>{categories.data?.filter(c=>c.active||c.id===target?.categoryId).map(c=><option key={c.id} value={c.id}>{c.name}{!c.active?' (inactiva)':''}</option>)}</select>{categories.error&&<p role="alert" className="text-sm text-destructive">{categories.error}</p>}</div>
    <div className="space-y-2"><Label htmlFor="product-unit">Unidad de medida</Label><select id="product-unit" className={choiceClass} value={form.unitCode} onChange={event=>{setForm(current=>({...current,unitCode:event.target.value}));setChanged(true);}}>{units.data?.filter(u=>u.active||u.code===target?.unitCode).map(u=><option key={u.code} value={u.code}>{u.code} · {u.description}{!u.active?' (inactiva)':''}</option>)}</select>{units.error&&<p role="alert" className="text-sm text-destructive">{units.error}</p>}</div>
    <div className="rounded-lg border p-3 text-sm sm:col-span-2"><p>Afectación IGV: {TAX_TREATMENTS.find(t=>t.code===effectiveTreatment)?.label} ({effectiveTreatment})</p><p className="font-semibold">Tasa IGV: {effectiveTreatment==='10'?policy.data?.policy.rate??'18.00':'0'} %</p><p className="mt-2 text-muted-foreground">La afectación y tasa se heredan del RUC/sede seleccionados. Administre cada asignación en Política tributaria y GRE; la región Selva por sí sola no exonera.</p>{policy.error&&<p role="alert">{policy.error}</p>}</div><label className="flex items-center gap-3 text-sm"><Checkbox checked={form.active} onCheckedChange={value => { setForm(current => ({ ...current, active: value === true })); setChanged(true); }} />Producto activo</label></fieldset>{error && <ErrorState message={error} />}<DialogFooter><Button disabled={busy} variant="outline" onClick={() => setOpen(false)}>Cancelar</Button><Button disabled={busy || !form.sku || !form.description || !form.categoryId} onClick={() => void save()}>Guardar producto</Button></DialogFooter></DialogContent></Dialog>
  </CardContent></Card>;
}
