"use client";
import { ProductionNotesActivation } from '../../../features/workspace/production-notes-activation';
import { ProductionActivation } from '../../../features/workspace/production-activation';
import { useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, ShieldCheck, Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@factuez/ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@factuez/ui/components/select";
import { Button } from "@factuez/ui/components/button";
import { Badge } from "@factuez/ui/components/badge";
import { Input } from "@factuez/ui/components/input";
import { Label } from "@factuez/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@factuez/ui/components/dialog";
import { ErrorState, Loading, PageHeading } from "../../../features/workspace/common";
import { useResource, useWorkspace } from "../../../features/workspace/provider";
import type { Company } from "../../../features/workspace/types";
import { FiscalReadiness } from '../../../features/workspace/fiscal-readiness';

type ConfigurationStatus = {
  ruc: string; environment: string; revision: number; updatedAt: string | null;
  certificate: { configured: boolean; fingerprint: string | null; expiresAt: string | null;
    selfSigned: boolean | null; expired: boolean; trustAndRucVerified: false };
  solConfigured: boolean; greConfigured: boolean; fiscalTransmission: false;
};

export default function SunatSettingsPage() {
  const { user, catalog, companyId, dirty, can } = useWorkspace();
  const [environment, setEnvironment] = useState("BETA");
  const company = catalog?.companies.find(company => String(company.id) === companyId);
  if (!can("sunat.configure") || user?.scope.kind !== "GLOBAL" || !user.roles.includes("ADMIN"))
    return <ErrorState message="Esta configuración requiere un administrador general." />;
  return <>
    <PageHeading eyebrow="Administración fiscal" title="Configuración SUNAT"
      description="Administra el certificado digital y los accesos de cada empresa." />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4">
      <div><p className="text-sm font-medium">{company?.legalName ?? "Seleccione un emisor"}</p>
        <p className="text-xs text-muted-foreground">RUC {company?.ruc ?? "—"} · Emisor elegido en la cabecera del sistema</p></div>
      <Select value={environment} onValueChange={setEnvironment} disabled={dirty}>
        <SelectTrigger className="w-52" aria-label="Ambiente de credenciales"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="BETA">Beta / pruebas</SelectItem><SelectItem value="PRODUCTION">Producción</SelectItem></SelectContent>
      </Select>
    </div>
    {company ? <ConfigurationForm key={`${company.id}:${environment}`} company={company} environment={environment} />
      : <ErrorState message="Seleccione explícitamente un emisor en la cabecera antes de configurar SUNAT. Si aún no existe, créelo en Sedes y maestros." />}
    {company && environment === "PRODUCTION" && <ProductionActivation key={`dispatch:${company.id}`} companyId={company.id} />}
    {company && environment === "PRODUCTION" && <ProductionNotesActivation key={`notes:${company.id}`} companyId={company.id} />}
    {company && <FiscalReadiness key={`readiness:${company.id}:${environment}`} companyId={company.id} environment={environment} />}
  </>;
}

function ConfigurationForm({ company, environment }: { company: Company; environment: string }) {
  const { api, setDirty } = useWorkspace();
  const path = `/api/v1/setup/sunat/${company.id}/${environment}`;
  const resource = useResource<ConfigurationStatus>(path);
  const [file, setFile] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [certificatePassword, setCertificatePassword] = useState("");
  const [solUsername, setSolUsername] = useState("");
  const [solPassword, setSolPassword] = useState("");
  const [greClientId, setGreClientId] = useState("");
  const [greClientSecret, setGreClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [remove, setRemove] = useState<"certificate" | "sol" | "gre">();
  const [auditVersion, setAuditVersion] = useState(0);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState(false);
  const [secureTransport, setSecureTransport] = useState(false);
  const changed = Boolean(file || certificatePassword || solUsername || solPassword || greClientId || greClientSecret);
  useEffect(() => { setDirty(changed); return () => setDirty(false); }, [changed, setDirty]);
  useEffect(() => {
    setSecureTransport(location.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
  }, []);
  function clear() {
    setFile(undefined); if (fileInput.current) fileInput.current.value = "";
    setCertificatePassword(""); setSolUsername(""); setSolPassword(""); setGreClientId(""); setGreClientSecret("");
    setDirty(false); setError(undefined);
  }
  async function save() {
    if (!resource.data || busy || !secureTransport) return;
    setBusy(true); setError(undefined); setSuccess(false); setConfirm(false);
    try {
      const body: Record<string, unknown> = { expectedRevision: resource.data.revision };
      if (file || certificatePassword) {
        if (!file || !certificatePassword || file.size > 512 * 1024 || !/\.(p12|pfx)$/i.test(file.name))
          throw new Error("Seleccione un .p12/.pfx de hasta 512 KB e ingrese su contraseña.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        body.certificate = { fileName: file.name, base64: btoa(binary), password: certificatePassword };
        bytes.fill(0);
      }
      if (solUsername || solPassword) {
        if (!solUsername || !solPassword) throw new Error("Complete usuario secundario y contraseña SOL.");
        body.sol = { username: solUsername.trim(), password: solPassword };
      }
      if (greClientId || greClientSecret) {
        if (!greClientId || !greClientSecret) throw new Error("Complete Client ID y Client Secret GRE.");
        body.gre = { clientId: greClientId.trim(), clientSecret: greClientSecret };
      }
      await api(path, { method: "POST", body: JSON.stringify(body) });
      clear(); setSuccess(true); resource.reload();
      setAuditVersion(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo guardar la configuración"); }
    finally { setBusy(false); }
  }
  async function removeGroup() {
    if (!resource.data || !remove || busy || !secureTransport || changed) return;
    setBusy(true); setError(undefined);
    try {
      await api(path, { method: "POST", body: JSON.stringify({ expectedRevision: resource.data.revision, remove: [remove] }) });
      setRemove(undefined); setSuccess(true); resource.reload(); setAuditVersion(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo retirar la configuración"); }
    finally { setBusy(false); }
  }
  const status = resource.data;
  return <div className="space-y-5">
    <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <ShieldCheck className="mt-0.5 size-5 shrink-0" />
      <div><p className="font-medium">Envío oficial pendiente de habilitación</p>
        <p className="mt-1">Consulte el estado de habilitación al final de esta página. Las credenciales se guardan por empresa y ambiente.</p></div>
    </div>
    {!secureTransport && <ErrorState message="Abra esta pantalla mediante HTTPS. HTTP sólo se permite para pruebas en localhost; no cargue secretos reales por la intranet sin TLS." />}
    {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !status ? <Loading /> : <>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">RUC {status.ruc}</Badge>
        <Badge variant="outline">{environment === "BETA" ? "Beta / pruebas" : "Producción"}</Badge>
        <Badge variant="outline">Revisión {status.revision}</Badge>
        {status.updatedAt && <span className="text-xs text-muted-foreground">Actualizado: {new Date(status.updatedAt).toLocaleString("es-PE", { timeZone: "America/Lima" })}</span>}
      </div>
      <fieldset disabled={busy || !secureTransport} className="grid min-w-0 gap-5 xl:grid-cols-3">
        <Card className="min-w-0"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" />Certificado digital</CardTitle>
          <CardDescription>PKCS#12 (.p12 / .pfx), hasta 512 KB.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><Badge variant="outline">{status.certificate.configured ? status.certificate.expired ? "Vencido" : "Guardado · validación local" : "Sin certificado"}</Badge>
            {status.certificate.fingerprint && <p className="break-all text-xs text-muted-foreground">SHA-256: {status.certificate.fingerprint}</p>}
            {status.certificate.expiresAt && <p className="text-xs">Vence: {new Date(status.certificate.expiresAt).toLocaleDateString("es-PE", { timeZone: "America/Lima" })}</p>}
            {status.certificate.selfSigned && <p className="text-xs text-amber-700">Autofirmado: únicamente validación local, no aprobado para emisión fiscal.</p>}
            {status.certificate.configured && <Button type="button" variant="outline" disabled={changed} onClick={() => setRemove("certificate")}>Retirar certificado y contraseña</Button>}
            <div className="space-y-2"><Label htmlFor="certificate-file">Nuevo certificado</Label><Input id="certificate-file" ref={fileInput} type="file" accept=".p12,.pfx" onChange={event => { setFile(event.target.files?.[0]); setSuccess(false); }} /></div>
            <div className="space-y-2"><Label htmlFor="certificate-password">Contraseña del certificado</Label><Input id="certificate-password" type="password" autoComplete="new-password" value={certificatePassword} onChange={event => setCertificatePassword(event.target.value)} maxLength={512} /></div>
          </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Credenciales SOL</CardTitle><CardDescription>Usuario secundario. Sin RUC como prefijo.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><Badge variant="outline">{status.solConfigured ? "Guardadas" : "Sin configurar"}</Badge>
            {status.solConfigured && <Button type="button" variant="outline" disabled={changed} onClick={() => setRemove("sol")}>Retirar credenciales SOL</Button>}
            <div className="space-y-2"><Label htmlFor="sol-user">Usuario secundario</Label><Input id="sol-user" autoComplete="off" value={solUsername} onChange={event => setSolUsername(event.target.value)} maxLength={80} /></div>
            <div className="space-y-2"><Label htmlFor="sol-password">Contraseña SOL</Label><Input id="sol-password" type="password" autoComplete="new-password" value={solPassword} onChange={event => setSolPassword(event.target.value)} maxLength={512} /></div>
          </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">API de guías (GRE)</CardTitle><CardDescription>Client ID y Client Secret del servicio de guías electrónicas.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><Badge variant="outline">{status.greConfigured ? "Guardadas" : "Sin configurar"}</Badge>
            {status.greConfigured && <Button type="button" variant="outline" disabled={changed} onClick={() => setRemove("gre")}>Retirar credenciales GRE</Button>}
            <div className="space-y-2"><Label htmlFor="gre-client">Client ID</Label><Input id="gre-client" autoComplete="off" value={greClientId} onChange={event => setGreClientId(event.target.value)} maxLength={160} /></div>
            <div className="space-y-2"><Label htmlFor="gre-secret">Client Secret</Label><Input id="gre-secret" type="password" autoComplete="new-password" value={greClientSecret} onChange={event => setGreClientSecret(event.target.value)} maxLength={512} /></div>
          </CardContent></Card>
      </fieldset>
      <p className="text-xs text-muted-foreground">Deje los campos vacíos para conservar las credenciales guardadas. Los cambios quedan cifrados y registrados en el historial.</p>
      {error && <ErrorState message={error} />}
      {success && <p role="status" className="text-sm text-emerald-700">Configuración guardada. No se enviaron comprobantes a SUNAT.</p>}
      <div className="flex flex-wrap justify-end gap-3"><Button variant="outline" disabled={busy || !changed} onClick={clear}>Descartar campos</Button>
        <Button disabled={busy || !changed || !secureTransport} onClick={() => setConfirm(true)}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}Guardar configuración</Button></div>
    </>}
    {status && <ConfigurationAudit key={`${path}:${auditVersion}`} path={path} />}
    <Dialog open={Boolean(remove)} onOpenChange={open => { if (!busy && !open) setRemove(undefined); }}><DialogContent><DialogHeader><DialogTitle>Retirar {remove === "certificate" ? "certificado" : remove === "sol" ? "credenciales SOL" : "credenciales GRE"}</DialogTitle><DialogDescription>Se retira únicamente este grupo activo de {company.legalName}, RUC {company.ruc}, en {environment === "BETA" ? "Beta" : "Producción"}. Se conserva la auditoría y no se modifican XML, CDR, comprobantes ni correlativos. Esto no revoca el certificado ante su entidad certificadora. Para volver a usarlo tendrá que cargarlo nuevamente.</DialogDescription></DialogHeader>{error && <ErrorState message={error} />}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemove(undefined)}>Cancelar</Button><Button variant="destructive" disabled={busy || changed || !secureTransport} onClick={() => void removeGroup()}>Confirmar retiro</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>Confirmar configuración fiscal</DialogTitle>
      <DialogDescription>Se guardarán las credenciales para {company.legalName}, RUC {company.ruc}, ambiente {environment}. Se reemplazan únicamente los grupos completados. No se activa transmisión.</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>Cancelar</Button><Button onClick={() => void save()}>Confirmar y guardar</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function ConfigurationAudit({ path }: { path: string }) {
  const [page, setPage] = useState(1);
  const resource = useResource<{ page: number; pageSize: number; total: number; items: { id: string; actorId: string; fields: string[]; revision: number; occurredAt: string }[] }>(`${path}/audit?page=${page}`);
  const labels: Record<string,string> = { certificate: "Certificado reemplazado", sol: "SOL reemplazadas", gre: "GRE reemplazadas", "certificate.remove": "Certificado retirado", "sol.remove": "SOL retiradas", "gre.remove": "GRE retiradas" };
  return <Card><CardHeader><CardTitle className="text-base">Historial de configuración</CardTitle><CardDescription>Cambios de este RUC y ambiente. No contiene contraseñas ni archivos del certificado.</CardDescription></CardHeader><CardContent className="space-y-4">{resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !resource.data ? <Loading /> : <><div className="divide-y">{resource.data.items.map(item => <div className="py-3 text-sm" key={item.id}><p className="font-medium">Revisión {item.revision} · {item.fields.map(field => labels[field] ?? "Configuración actualizada").join(", ")}</p><p className="mt-1 break-all text-xs text-muted-foreground">{new Date(item.occurredAt).toLocaleString("es-PE", { timeZone: "America/Lima" })} · ID del responsable: {item.actorId}</p></div>)}</div>{!resource.data.total && <p className="text-sm text-muted-foreground">No hay cambios registrados en este ambiente.</p>}<div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{resource.data.total} cambios · Página {page}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Anterior</Button><Button size="sm" variant="outline" disabled={page * resource.data.pageSize >= resource.data.total} onClick={() => setPage(value => value + 1)}>Siguiente</Button></div></div></>}</CardContent></Card>;
}
