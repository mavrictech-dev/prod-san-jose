"use client";
import { useResource } from './provider';
import { ErrorState, Loading } from './common';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@factuez/ui/components/card';
import { Badge } from '@factuez/ui/components/badge';
import { Button } from '@factuez/ui/components/button';
import { readinessLabels } from './fiscal-help';

type Check = { code: string; status: string; description: string };
type Report = {
  ruc: string; environment: string; state: string; fiscalTransmission: boolean;
  readyForOfficialBeta: boolean; readyForProduction: boolean; checkedAt: string;
  checks: Check[];
  rules: { profile: string; source: { publishedVersion: string }; coverage: { capability: string; status: string }[] };
};
const customerChecks = new Set(['ISSUER_REAL_RUC', 'SOL_SECRETS_LOCAL', 'GRE_SECRETS_LOCAL', 'CERTIFICATE_KEY_PAIR', 'CERTIFICATE_RUC', 'SUNAT_REGISTRATION', 'EMITTER_REGISTRATION_ATTESTED']);
const labels: Record<string, string> = { PASS: 'Verificado', BLOCKED: 'Pendiente', PENDING: 'Por verificar', NOT_APPLICABLE: 'Opcional' };
const coverageLabels: Record<string, string> = { LOCAL_PROFILE_VALIDATED: 'Validado localmente', UNSUPPORTED_FAIL_CLOSED: 'Fuera del perfil', SEPARATE_PROFILE_REQUIRED: 'Perfil adicional', NOT_FULLY_AUTOMATED: 'Validación parcial' };
function Checks({ items }: { items: Check[] }) {
  return <div className="divide-y">{items.map(check => <div className="flex items-start justify-between gap-4 py-3" key={check.code}>
    <span className="text-sm">{readinessLabels[check.code] ?? 'Verificación adicional'}</span>
    <Badge variant="outline" className={check.status === 'PASS' ? 'shrink-0 text-emerald-700' : 'shrink-0'}>{labels[check.status] ?? 'Por verificar'}</Badge>
  </div>)}</div>;
}
export function FiscalReadiness({ companyId, environment }: { companyId: number; environment: string }) {
  const resource = useResource<Report>(`/api/v1/setup/sunat/${companyId}/${environment}/readiness`);
  const report = resource.data;
  const matches = report?.environment === environment;
  // A selected environment or a saved certificate never implies live transmission.
  const enabled = matches && report.fiscalTransmission === true &&
    (environment === 'PRODUCTION' ? report.readyForProduction === true : report.readyForOfficialBeta === true);
  return <Card className="mt-6 shadow-none"><CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
    <div className="space-y-1"><CardTitle>Estado de habilitación</CardTitle><CardDescription>{environment === 'PRODUCTION' ? 'Producción' : 'Beta / pruebas'}</CardDescription></div>
    {report && <Badge variant="outline">{enabled ? 'Envíos habilitados' : 'Envíos no habilitados'}</Badge>}
  </CardHeader><CardContent className="space-y-5">
    {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !report ? <Loading /> : !matches ?
      <ErrorState message="No se pudo confirmar el ambiente de esta revisión." retry={resource.reload} /> : <>
      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label="Configuración del emisor"><h3 className="text-sm font-medium">Configuración del emisor</h3><Checks items={report.checks.filter(check => customerChecks.has(check.code))} /></section>
        <section aria-label="Preparación de la plataforma"><h3 className="text-sm font-medium">Preparación de la plataforma</h3><Checks items={report.checks.filter(check => !customerChecks.has(check.code))} /></section>
      </div>
      <details className="rounded-lg border p-4 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Detalle de las verificaciones</summary>
        <dl className="mt-4 space-y-3">{report.checks.map(check => <div key={check.code}><dt className="font-medium text-foreground">{readinessLabels[check.code] ?? check.code}</dt><dd className="mt-1">{check.description}</dd></div>)}</dl>
        <p className="my-4">Perfil {report.rules.profile} · Versión {report.rules.source.publishedVersion}</p>
        <ul className="space-y-2">{report.rules.coverage.map(item => <li key={item.capability}>{item.capability} · {coverageLabels[item.status] ?? 'Por verificar'}</li>)}</ul>
      </details>
      <p className="text-xs text-muted-foreground">Última revisión: {new Date(report.checkedAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</p>
    </>}
    <Button variant="outline" onClick={resource.reload}>Actualizar estado</Button>
  </CardContent></Card>;
}
