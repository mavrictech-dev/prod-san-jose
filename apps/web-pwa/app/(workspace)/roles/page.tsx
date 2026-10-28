"use client";
import { useState } from "react";
import { Button } from "@factuez/ui/components/button";
import { Checkbox } from "@factuez/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@factuez/ui/components/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@factuez/ui/components/card";
import { Badge } from "@factuez/ui/components/badge";
import { useResource, useWorkspace } from "../../../features/workspace/provider";
import {
  ErrorState,
  Loading,
  PageHeading,
  rolesText,
} from "../../../features/workspace/common";
import type { Role } from "../../../features/workspace/types";
const labels: Record<string, string> = {
  "setup.manage": "Configurar empresa y sedes",
  "user.manage": "Administrar usuarios",
  "role.manage": "Asignar roles",
  "product.manage": "Administrar productos",
  "series.manage": "Administrar series",
  "sunat.configure": "Configurar SUNAT",
  "document.issue": "Emitir documentos",
  "document.view": "Consultar documentos",
  "document.retry": "Reintentar envíos",
  "document.email": "Enviar por correo",
  "shift.open": "Abrir turno",
  "shift.close": "Cerrar turno",
  "report.view": "Consultar reportes",
  "report.export": "Exportar reportes",
  "audit.view": "Consultar auditoría",
};
export default function RolesPage() {
  const { data, error, reload } = useResource<Role[]>("/api/v1/roles");
  const { api } = useWorkspace();
  const [target, setTarget] = useState<Role>();
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  async function save() {
    if (!target || saving) return;
    setSaving(true); setSaveError(undefined);
    try {
      await api(`/api/v1/roles/${target.code}`, { method: "PATCH", body: JSON.stringify({ permissions: selected, expectedPermissions: target.permissions }) });
      setTarget(undefined); reload(); setNotice("Permisos guardados. Las cuentas afectadas deberán iniciar sesión nuevamente.");
    } catch (error) { setSaveError(error instanceof Error ? error.message : "No se pudieron guardar los permisos"); }
    finally { setSaving(false); }
  }
  return (
    <>
      <PageHeading
        eyebrow="Seguridad"
        title="Roles y permisos"
        description="Permisos actuales de cada rol. Las asignaciones conservan su alcance por sede, punto y serie."
      />
      <div className="mb-6 rounded-lg border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
        Consultar, emitir, administrar y exportar son permisos distintos. Cambiar un permiso no amplía las sedes asignadas ni habilita funciones fiscales bloqueadas. El administrador general está protegido.
      </div>
      {notice && <p role="status" className="mb-4 text-sm text-emerald-700">{notice}</p>}
      {error ? (
        <ErrorState message={error} retry={reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {data.map((role) => (
            <Card key={role.code} className="shadow-none">
              <CardHeader>
                <div className="mb-2">
                  <Badge variant={role.assignable ? "secondary" : "outline"}>
                    {role.assignable
                      ? "Puedes asignarlo"
                      : "Asignación restringida"}
                  </Badge>
                </div>
                <CardTitle>{rolesText[role.code] ?? role.name}</CardTitle>
                <CardDescription>
                  {role.code === "ADMIN"
                    ? "Acceso global a los emisores RUC y todas sus sedes."
                    : role.code === "STATION_MANAGER"
                      ? "Gestiona operación y usuarios de su propio alcance, sin delegar administración general."
                      : "Sus permisos se aplican únicamente a los recursos asignados."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {role.editable && <Button size="sm" variant="outline" className="mb-4" onClick={() => { setTarget(role); setSelected([...role.permissions]); setSaveError(undefined); }}>Editar permisos</Button>}
                <ul className="space-y-2 text-sm">
                  {role.permissions.map((permission) => (
                    <li key={permission} className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-primary" />
                      {labels[permission] ?? permission}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={Boolean(target)} onOpenChange={open => { if (!open && !saving) setTarget(undefined); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Permisos de {target ? rolesText[target.code] ?? target.name : "rol"}</DialogTitle><DialogDescription>Estos cambios afectan a todas las cuentas con este rol. No cambian las sedes, puntos ni series autorizados. Algunas administraciones requieren además el rol de administrador general.</DialogDescription></DialogHeader><div className="grid gap-2">{Object.entries(labels).map(([code, label]) => <label key={code} className="flex items-center gap-3 rounded-md border p-3 text-sm"><Checkbox disabled={saving} checked={selected.includes(code)} onCheckedChange={value => setSelected(current => value === true ? [...current.filter(item => item !== code), code] : current.filter(item => item !== code))} />{label}</label>)}</div>{saveError && <ErrorState message={saveError} />}<DialogFooter><Button variant="outline" disabled={saving} onClick={() => setTarget(undefined)}>Cancelar</Button><Button disabled={saving} onClick={() => void save()}>Guardar permisos</Button></DialogFooter></DialogContent></Dialog>
    </>
  );
}
