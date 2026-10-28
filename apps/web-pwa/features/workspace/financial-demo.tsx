"use client";
import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Button } from '@factuez/ui/components/button';
import { Label } from '@factuez/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@factuez/ui/components/select';
import { ErrorState } from './common';
import { useWorkspace } from './provider';

const scenarios = [
  ['CREDIT_ACCEPTED', 'Nota de crédito · efecto simulado'], ['DEBIT_ACCEPTED', 'Nota de débito · efecto simulado'],
  ['RC_REPLACE', 'Modificación RC · versión separada'], ['VOID', 'Baja · conserva el comprobante original'],
  ['CDR_UNVERIFIED', 'CDR no verificado · sin efecto'], ['REJECTED', 'Rechazo · sin efecto'],
  ['REPLAY', 'Evento duplicado · sin doble efecto'], ['STALE_VERSION', 'Versión antigua · bloqueada'],
] as const;
type Preview = { profile: 'FINANCIAL_DEMO_BETA_V1'; scenario: string; localOnly: true; simulationOnly: true;
  source: 'FIXED_SYNTHETIC_FIXTURE'; fiscalWrites: 0; certificateAccess: false; transmissionAuthorized: false;
  evidenceAuthenticityVerified: false; originalPreserved: true; originalPayableAmount: string;
  result: { ok: false; code: string } | { ok: true; versionCount: number; financialPayableAmount: string; outcomes: string[];
    currentVersion: { revision: number; state: string; sha256: string; net: { payableAmount: string };
      credited: { payableAmount: string }; debited: { payableAmount: string }; creditCapacity: { payableAmount: string } } } };
export function FinancialDemo() {
  const { api, user } = useWorkspace();
  const [scenario, setScenario] = useState<string>('CREDIT_ACCEPTED');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [preview, setPreview] = useState<Preview>();
  const flight = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => flight.current?.abort(), []);
  useEffect(() => { flight.current?.abort(); setPreview(undefined); setError(undefined); setBusy(false); }, [user?.sub]);
  async function simulate() {
    if (busy) return;
    const controller = new AbortController(); flight.current = controller;
    setBusy(true); setError(undefined); setPreview(undefined);
    try {
      const result = await api<Preview>('/api/v1/fiscal-rules/financial-ledger-preview', { method: 'POST', body: JSON.stringify({ scenario }), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.profile !== 'FINANCIAL_DEMO_BETA_V1' || result.scenario !== scenario || result.localOnly !== true || result.simulationOnly !== true ||
          result.source !== 'FIXED_SYNTHETIC_FIXTURE' || result.fiscalWrites !== 0 || result.certificateAccess !== false || result.transmissionAuthorized !== false ||
          result.evidenceAuthenticityVerified !== false || result.originalPreserved !== true || !result.result || typeof result.result.ok !== 'boolean')
        throw new Error('Respuesta fuera del laboratorio ficticio; solicite revisión.');
      setPreview(result);
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'No se pudo simular.'); }
    finally { if (flight.current === controller) setBusy(false); }
  }
  const result = preview?.result;
  return <Card className="mt-6"><CardHeader><CardTitle>Conciliación financiera · Simulación Beta</CardTitle>
    <CardDescription>Prueba notas, versiones RC, bajas y replay con datos ficticios. No usa tu empresa ni sus credenciales.</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        CDR y evidencias inventados, sin validación PKI. No crea ventas, reservas, firmas, correos ni envíos. Producción permanece bloqueada.
      </p>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end"><div className="w-full space-y-2 sm:max-w-md"><Label htmlFor="financial-demo-scenario">Escenario ficticio</Label>
        <Select value={scenario} disabled={busy} onValueChange={value => { setScenario(value); setPreview(undefined); setError(undefined); }}>
          <SelectTrigger id="financial-demo-scenario"><SelectValue /></SelectTrigger><SelectContent>{scenarios.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select></div><Button type="button" onClick={simulate} disabled={busy}>{busy ? 'Simulando…' : 'Ejecutar simulación local'}</Button></div>
      {error && <ErrorState message={error} />}
      <div aria-live="polite">{result && (result.ok ? <>
        <dl className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-3">{([
          ['Original conservado', preview!.originalPayableAmount], ['Total de la versión financiera', result.financialPayableAmount], ['Neto con notas simuladas', result.currentVersion.net.payableAmount],
          ['Créditos simulados', result.currentVersion.credited.payableAmount], ['Débitos simulados', result.currentVersion.debited.payableAmount], ['Capacidad de crédito restante', result.currentVersion.creditCapacity.payableAmount],
        ] as const).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-mono font-medium tabular-nums">PEN {value}</dd></div>)}</dl>
        <p className="mt-3 text-xs text-muted-foreground">Versión {result.currentVersion.revision} · {result.currentVersion.state === 'VOIDED' ? 'Baja simulada, importes conservados' : 'Activa en simulación'} · {result.versionCount} versiones · {result.outcomes.join(', ')}</p>
      </> : <p role="alert" className="rounded-md border border-amber-200 p-3 text-sm">Simulación bloqueada: {result.code}. No se aplicó ningún cambio.</p>)}</div>
    </CardContent></Card>;
}
