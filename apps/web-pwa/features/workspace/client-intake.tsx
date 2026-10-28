"use client";
import { useEffect, useState } from "react";
import type { ClientIntakePending, ClientIntakeReportV1 } from "@factuez/contracts";
import { Download, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@factuez/ui/components/card";
import { Badge } from "@factuez/ui/components/badge";
import { Button } from "@factuez/ui/components/button";
import { Input } from "@factuez/ui/components/input";
import { Label } from "@factuez/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@factuez/ui/components/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@factuez/ui/components/table";
import { ErrorState, Loading } from "./common";
import { useWorkspace } from "./provider";
import { clientIntakeRows, isClientIntakeReport } from "./client-intake-model";
import { intakeMapCsv, intakeScopeTemplate } from "./client-intake-templates";

const owners: Record<ClientIntakePending["owner"], string> = {
  TI: "TI", ADMINISTRACION_CONTABILIDAD: "Administración / Contabilidad",
  EMISOR: "Responsable del emisor", MAVRIC: "Mavric Technologies",
};
function download(content: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ClientIntakePanel({ report, onRefresh }: { report: ClientIntakeReportV1; onRefresh?: () => void }) {
  const [ruc, setRuc] = useState("all");
  const [query, setQuery] = useState("");
  if (!isClientIntakeReport(report)) return <ErrorState message="La respuesta no corresponde al expediente parcial BETA de preparación. No se mostraron ni aplicaron datos." />;
  const rows = clientIntakeRows(report, ruc, query);
  const allRows = clientIntakeRows(report);
  return (
    <section className="space-y-5" aria-label="Entrega del cliente · preparación fases 2 y 3" data-testid="client-intake-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Preparación de fases 2 y 3</h2>
          <p className="mt-1 text-sm text-muted-foreground">Entrega revisada el 05/10/2026 · Configuración empresarial parcial, no historial importado.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">BETA · Solo lectura</Badge>
          {onRefresh && <Button size="sm" variant="outline" onClick={onRefresh}><RefreshCw className="size-4" />Actualizar</Button>}
        </div>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        <p className="font-medium">Producción, importación y corte bloqueados</p>
        <p className="mt-1">Esta entrega no registra emisores, puntos, series ni comprobantes en la base de datos. No verifica identidad ante SUNAT, firma ni CDR, y no habilita envíos. Las fases 2 y 3 siguen pendientes de cierre.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[{ label: "Empresas según fichas RUC", value: report.summary.companyCount }, { label: "Sedes según anexo", value: report.summary.branchCount }, { label: "Muestras PDF recibidas", value: report.summary.pdfSampleCount }, { label: "XML firmados / CDR originales", value: "0 / 0" }].map((metric) => (
          <Card key={metric.label} className="shadow-none"><CardHeader className="pb-2"><CardDescription>{metric.label}</CardDescription><CardTitle className="text-2xl tabular-nums">{metric.value}</CardTitle></CardHeader></Card>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {report.data.companies.map((company) => (
          <Card key={company.ruc} className="shadow-none">
            <CardHeader>
              <Badge variant="outline" className="w-fit font-mono">RUC {company.ruc}</Badge>
              <CardTitle className="text-base leading-snug">{company.legalName}</CardTitle>
              <CardDescription>{report.summary.rucBranchCounts.find((entry) => entry.ruc === company.ruc)?.count} sedes según anexo · No creado por esta entrega</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="break-words text-muted-foreground">{company.taxAddress}</p>
              <p>Ubigeo numérico: <span className="text-muted-foreground">pendiente</span></p>
              <p className="text-xs text-muted-foreground">Datos de ficha aportada; sin verificación en línea. Certificado y credenciales se revisan por separado en Configuración SUNAT.</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {report.data.nameDiscrepancies.map((difference) => (
        <Card key={difference.issuerRuc} className="border-amber-200 shadow-none dark:border-amber-900">
          <CardHeader><CardTitle className="text-base">Razón social por confirmar · {difference.issuerRuc}</CardTitle><CardDescription>No se corrigió ni sustituyó automáticamente ningún emisor.</CardDescription></CardHeader>
          <CardContent className="space-y-2 text-sm"><p><span className="text-muted-foreground">Respuesta Word: </span>{difference.wordLegalName}</p><p><span className="text-muted-foreground">Ficha RUC: </span>{difference.sheetLegalName}</p><p className="text-xs text-muted-foreground">Administración / Contabilidad debe resolver esta diferencia antes del alta definitiva.</p></CardContent>
        </Card>
      ))}
      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-lg">Mapa parcial empresa–sede</CardTitle><CardDescription>Las series de las muestras PDF no se asignan a sedes. Dirección, establecimiento, punto y series siguen pendientes.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_260px]">
            <div className="space-y-2"><Label htmlFor="intake-search">Buscar sede, código o RUC</Label><Input id="intake-search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={120} placeholder="Ej.: Pucallpa, SJ1…" /></div>
            <div className="space-y-2"><Label htmlFor="intake-ruc">RUC de esta entrega</Label><Select value={ruc} onValueChange={setRuc}><SelectTrigger id="intake-ruc"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos los RUC recibidos</SelectItem>{report.data.companies.map((company) => <SelectItem key={company.ruc} value={company.ruc}>{company.ruc}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <Table>
            <TableHeader><TableRow><TableHead>Código</TableHead><TableHead>Sede</TableHead><TableHead>RUC según anexo</TableHead><TableHead>Dirección / establecimiento</TableHead><TableHead>Punto / series</TableHead></TableRow></TableHeader>
            <TableBody>{rows.length ? rows.map((row) => <TableRow key={row.branchCode}><TableCell className="font-mono">{row.branchCode}</TableCell><TableCell className="font-medium">{row.branchName}</TableCell><TableCell className="font-mono text-xs">{row.issuerRuc}</TableCell><TableCell className="text-xs text-muted-foreground">Pendiente de confirmar</TableCell><TableCell className="text-xs text-muted-foreground">Pendiente de confirmar</TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">Sin sedes que coincidan con este filtro.</TableCell></TableRow>}</TableBody>
          </Table>
          <p aria-live="polite" className="text-xs text-muted-foreground">Mostrando {rows.length} de {report.summary.branchCount} sedes. Este filtro no cambia el emisor activo de operación.</p>
        </CardContent>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        {([2, 3] as const).map((phase) => (
          <Card key={phase} className="shadow-none">
            <CardHeader><CardTitle className="text-lg">Fase {phase} · {phase === 2 ? "Circuito fiscal" : "Historial y conciliación"}</CardTitle><CardDescription>Cierre pendiente. Responsabilidades separadas del avance de código.</CardDescription></CardHeader>
            <CardContent><ul className="space-y-4">{report.pending.filter((item) => item.phase === phase).map((item) => <li key={item.id} className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0"><Badge variant="secondary" className="whitespace-normal text-left">{owners[item.owner]}</Badge><p className="text-sm leading-relaxed">{item.description}</p></li>)}</ul></CardContent>
          </Card>
        ))}
      </div>
      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-lg">Completar lo pendiente</CardTitle><CardDescription>Plantillas para TI y Contabilidad, no archivos de carga. Incluyen toda la entrega, no sólo las sedes filtradas.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => download(intakeMapCsv(allRows), "text/csv;charset=utf-8", "San_Jose_mapa_pendiente_20261005.csv")}><Download className="size-4" />Descargar mapa CSV</Button>
            <Button variant="outline" onClick={() => download(JSON.stringify(intakeScopeTemplate(report.data.companies.map((company) => company.ruc)), null, 2), "application/json", "San_Jose_alcance_por_autorizar_20261005.json")}><Download className="size-4" />Alcance por autorizar</Button>
            <Button variant="outline" onClick={() => download(JSON.stringify(report, null, 2), "application/json", "San_Jose_entrega_parcial_20261005.json")}><Download className="size-4" />Informe de entrega</Button>
          </div>
          <p className="text-xs text-muted-foreground">No añadir claves, certificados o datos de clientes a estas plantillas. El sistema no las ejecuta ni considera su descarga una aprobación.</p>
        </CardContent>
      </Card>
    </section>
  );
}

export function ClientIntakeWorkspace() {
  const { user, can, api } = useWorkspace();
  const allowed = user?.scope.kind === "GLOBAL" && user.roles.includes("ADMIN") && can("setup.manage");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ actorId: string; report?: ClientIntakeReportV1; error?: string }>();
  const actorId = user?.sub;
  useEffect(() => {
    if (!allowed || !actorId) { setState(undefined); return; }
    const controller = new AbortController();
    let active = true;
    setState({ actorId });
    api<unknown>("/api/v1/stations/client-intake", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) })
      .then((value) => {
        if (!isClientIntakeReport(value)) throw new Error("La respuesta no corresponde al expediente parcial BETA de preparación.");
        if (active) setState({ actorId, report: value });
      })
      .catch((reason: unknown) => {
        if (active) setState({ actorId, error: reason instanceof Error ? reason.message : "No se pudo consultar la entrega." });
      });
    return () => { active = false; controller.abort(); };
  }, [allowed, actorId, api, attempt]);
  if (!allowed) return <ErrorState message="La entrega del cliente requiere un administrador general con permiso de configuración." />;
  if (!state || state.actorId !== actorId || (!state.report && !state.error)) return <Loading />;
  if (state.error) return <ErrorState message={state.error} retry={() => setAttempt((value) => value + 1)} />;
  return <ClientIntakePanel key={actorId} report={state.report!} onRefresh={() => setAttempt((value) => value + 1)} />;
}
