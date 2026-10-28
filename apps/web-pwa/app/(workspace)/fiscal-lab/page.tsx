"use client";
import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Input } from '@factuez/ui/components/input';
import { Button } from '@factuez/ui/components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@factuez/ui/components/tabs';
import { Label } from '@factuez/ui/components/label';
import { ErrorState, PageHeading } from '../../../features/workspace/common';
import { useWorkspace } from '../../../features/workspace/provider';
import { FinancialDemo } from '../../../features/workspace/financial-demo';

type Preview = {
  profile: 'SALE_ADJUSTMENTS_BETA_V1'; localOnly: true; transmissionAuthorized: false;
  calculation: { environment: 'BETA'; currencyCode: 'PEN' | 'USD'; totals: {
    taxableAmount: string; exoneratedAmount: string; inaffectedAmount: string; igvAmount: string;
    totalBeforeAdvances: string; prepaidAmount: string; nonTaxDiscountAmount: string; payableAmount: string;
  } };
};
/** Percentage (<= 3 fractional digits) -> factor (<= 5), exactly, no Number. */
function discountFactor(value: string): string | undefined {
  if (!/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,3})?$/.test(value)) throw new Error('Ingrese un descuento de 0 a 100%, con hasta tres decimales.');
  const [whole, fraction = ''] = value.split('.');
  const thousandths = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (thousandths > 100_000n) throw new Error('El descuento no puede superar el 100%.');
  return thousandths === 0n ? undefined : `${thousandths / 100_000n}.${(thousandths % 100_000n).toString().padStart(5, '0')}`;
}

export default function FiscalLabPage() {
  const { api, user, can } = useWorkspace();
  const [affectation, setAffectation] = useState('10');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('118.00');
  const [percentage, setPercentage] = useState('0');
  const [currency, setCurrency] = useState('PEN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const flight = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => flight.current?.abort(), []);
  useEffect(() => { flight.current?.abort(); setPreview(undefined); setError(undefined); setBusy(false); }, [user?.sub]);
  const allowed = can('sunat.configure') && user?.scope.kind === 'GLOBAL' && user.roles.includes('ADMIN');
  if (!allowed) return <ErrorState message="El laboratorio fiscal requiere un administrador general." />;
  function clear() { setPreview(undefined); setError(undefined); }
  async function calculate() {
    if (busy) return;
    setError(undefined); setPreview(undefined);
    const controller = new AbortController(); flight.current = controller;
    try {
      const factor = affectation === '10' ? discountFactor(percentage) : undefined;
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const part = (type: string) => parts.find(item => item.type === type)!.value;
      const body = { environment: 'BETA', currencyCode: currency, issueDate: `${part('year')}-${part('month')}-${part('day')}`,
        lines: [{ id: '1', quantity, unitPriceWithTax: price, taxAffectationCode: affectation, igvRate: affectation === '10' ? '18' : '0' }],
        ...(factor ? { globalDiscounts: [{ reasonCode: '02', factor }] } : {}),
      };
      setBusy(true);
      const result = await api<Preview>('/api/v1/fiscal-rules/preview', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.profile !== 'SALE_ADJUSTMENTS_BETA_V1' || result.localOnly !== true || result.transmissionAuthorized !== false
        || result.calculation.environment !== 'BETA' || result.calculation.currencyCode !== currency) throw new Error('La respuesta no corresponde a una vista previa BETA local.');
      setPreview(result);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'No se pudo calcular la vista previa.');
    } finally { if (flight.current === controller) setBusy(false); }
  }
  const totals = preview?.calculation.totals;
  return <>
    <PageHeading eyebrow="Laboratorio fiscal · BETA" title="Vista previa de venta" description="Prueba bases, IGV y descuentos. Este cálculo no crea comprobantes." />
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Datos de la venta</CardTitle><CardDescription>Precios con IGV para operaciones gravadas.</CardDescription></CardHeader>
        <CardContent className="space-y-5"><fieldset disabled={busy} className="space-y-5">
          <Tabs value={affectation} onValueChange={value => { setAffectation(value); setPercentage('0'); clear(); }}>
            <TabsList className="grid w-full grid-cols-3"><TabsTrigger value="10" disabled={busy}>Gravada 10</TabsTrigger><TabsTrigger value="20" disabled={busy}>Exonerada 20</TabsTrigger><TabsTrigger value="30" disabled={busy}>Inafecta 30</TabsTrigger></TabsList>
            <TabsContent value="10" className="text-sm text-muted-foreground">IGV 18%. El descuento global 02 reduce la base gravada.</TabsContent>
            <TabsContent value="20" className="text-sm text-muted-foreground">Base exonerada separada; IGV cero.</TabsContent>
            <TabsContent value="30" className="text-sm text-muted-foreground">Base inafecta separada; IGV cero.</TabsContent>
          </Tabs>
          <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="lab-quantity">Cantidad</Label><Input id="lab-quantity" inputMode="decimal" maxLength={19} value={quantity} onChange={event => { setQuantity(event.target.value); clear(); }} /></div>
            <div className="space-y-2"><Label htmlFor="lab-price">Precio unitario</Label><Input id="lab-price" inputMode="decimal" maxLength={19} value={price} onChange={event => { setPrice(event.target.value); clear(); }} /></div></div>
          <Tabs value={currency} onValueChange={value => { setCurrency(value); clear(); }}><TabsList aria-label="Moneda"><TabsTrigger value="PEN" disabled={busy}>Soles · PEN</TabsTrigger><TabsTrigger value="USD" disabled={busy}>Dólares · USD</TabsTrigger></TabsList></Tabs>
          <div className="space-y-2"><Label htmlFor="lab-discount">Descuento global (%)</Label><Input id="lab-discount" inputMode="decimal" maxLength={7} value={percentage} disabled={affectation !== '10'} onChange={event => { setPercentage(event.target.value); clear(); }} />
            <p className="text-xs text-muted-foreground">Disponible para la base gravada 10. Usa punto decimal.</p></div>
          <Button type="button" onClick={calculate} disabled={busy} className="w-full">{busy ? 'Calculando…' : 'Calcular vista previa'}</Button>
        </fieldset>{error && <div role="alert"><ErrorState message={error} /></div>}</CardContent></Card>
      <Card aria-live="polite"><CardHeader><CardTitle>Resultado local</CardTitle><CardDescription>BETA · transmisión deshabilitada</CardDescription></CardHeader><CardContent>
        {totals ? <dl className="space-y-3 text-sm">{([
          ['Base gravada', totals.taxableAmount], ['Base exonerada', totals.exoneratedAmount], ['Base inafecta', totals.inaffectedAmount], ['IGV', totals.igvAmount], ['Anticipos', totals.prepaidAmount],
        ] as const).map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono tabular-nums">{currency} {value}</dd></div>)}
          <div className="flex justify-between gap-4 border-t pt-4 text-base font-semibold"><dt>Total por pagar</dt><dd className="font-mono tabular-nums">{currency} {totals.payableAmount}</dd></div></dl>
          : <p className="py-8 text-center text-sm text-muted-foreground">Ingresa una venta y calcula para ver sus importes.</p>}
      </CardContent></Card>
    </div>
    <FinancialDemo />
  </>;
}
