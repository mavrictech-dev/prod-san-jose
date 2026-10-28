'use client';

import { useMemo, useState } from 'react';
import { Plus, Printer, Send, Trash2 } from 'lucide-react';

type DocumentType = '03' | '01' | '09';
type InvoiceItem = { id: string; description: string; unit: string; quantity: number; unitPrice: number };

const newItem = (): InvoiceItem => ({ id: crypto.randomUUID(), description: '', unit: 'GLL', quantity: 1, unitPrice: 0 });

export function InvoiceEmitter() {
  const [documentType, setDocumentType] = useState<DocumentType>('03');
  const [customerDocument, setCustomerDocument] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [items, setItems] = useState<InvoiceItem[]>([{ id: 'fuel-regular', description: 'Gasohol Regular', unit: 'GLL', quantity: 3.5, unitPrice: 16.5 }]);
  const total = useMemo(() => items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0), [items]);
  const taxable = total / 1.18;
  const igv = total - taxable;
  const update = (id: string, field: keyof InvoiceItem, value: string | number) => setItems((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item));

  return (
    <section className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 shadow-sm">
          <h1 className="text-sm font-semibold">Datos del comprobante</h1>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium text-[var(--muted)]">Tipo de documento
              <select className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]" value={documentType} onChange={(event) => setDocumentType(event.target.value as DocumentType)}>
                <option value="03">Boleta electrónica</option><option value="01">Factura electrónica</option><option value="09">Guía de remisión remitente</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-[var(--muted)]">{documentType === '01' ? 'RUC cliente' : 'DNI / documento'}
              <input className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 font-mono text-xs text-[var(--foreground)]" value={customerDocument} onChange={(event) => setCustomerDocument(event.target.value)} placeholder={documentType === '01' ? '20XXXXXXXXX' : '7XXXXXXX'} />
            </label>
          </div>
          <label className="mt-3 grid gap-1 text-xs font-medium text-[var(--muted)]">Razón social / nombres
            <input className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Cliente ocasional / Razón Social" />
          </label>
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Detalle del despacho</h2><p className="mt-1 text-xs text-[var(--muted)]">Combustibles, lubricantes o servicios libres</p></div><button onClick={() => setItems((current) => [...current, newItem()])} className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs font-medium hover:bg-[var(--surface)]"><Plus className="h-3.5 w-3.5" />Agregar ítem</button></div>
          <div className="mt-4 space-y-2">
            {items.map((item) => <div className="grid grid-cols-12 items-center gap-2" key={item.id}>
              <input aria-label="Descripción" className="col-span-5 h-8 min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-xs" value={item.description} onChange={(event) => update(item.id, 'description', event.target.value)} placeholder="Producto o combustible" />
              <input aria-label="Cantidad" className="col-span-2 h-8 min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-right font-mono text-xs" type="number" min="0" step="0.001" value={item.quantity} onChange={(event) => update(item.id, 'quantity', Number(event.target.value) || 0)} />
              <input aria-label="Precio unitario" className="col-span-2 h-8 min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-right font-mono text-xs" type="number" min="0" step="0.01" value={item.unitPrice} onChange={(event) => update(item.id, 'unitPrice', Number(event.target.value) || 0)} />
              <span className="col-span-2 text-right font-mono text-xs font-semibold">S/ {(item.quantity * item.unitPrice).toFixed(2)}</span>
              <button aria-label="Quitar ítem" disabled={items.length === 1} onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} className="col-span-1 justify-self-center text-[var(--muted)] enabled:hover:text-red-600 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
            </div>)}
          </div>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"><h2 className="text-sm font-semibold">Liquidación</h2><dl className="mt-4 space-y-2 text-xs"><div className="flex justify-between text-[var(--muted)]"><dt>Operación gravada</dt><dd className="font-mono">S/ {taxable.toFixed(2)}</dd></div><div className="flex justify-between text-[var(--muted)]"><dt>IGV (18%)</dt><dd className="font-mono">S/ {igv.toFixed(2)}</dd></div><div className="mt-3 flex items-baseline justify-between border-t border-[var(--border)] pt-3"><dt className="text-sm font-semibold">Total a pagar</dt><dd className="font-mono text-xl font-bold">S/ {total.toFixed(2)}</dd></div></dl></div>
        <div className="space-y-2"><button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-zinc-900 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900"><Send className="h-3.5 w-3.5" />Emitir y transmitir</button><button className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--border)] text-xs font-medium hover:bg-[var(--surface)]"><Printer className="h-3.5 w-3.5" />Ticket rápido 80 mm</button></div>
      </aside>
    </section>
  );
}
