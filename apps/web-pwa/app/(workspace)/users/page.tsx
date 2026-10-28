"use client";
import { useEffect, useState } from "react";
import { Plus, Pencil, Users, LoaderCircle } from "lucide-react";
import { Button } from "@factuez/ui/components/button";
import { Card, CardContent } from "@factuez/ui/components/card";
import { Badge } from "@factuez/ui/components/badge";
import { Input } from "@factuez/ui/components/input";
import { Label } from "@factuez/ui/components/label";
import { Checkbox } from "@factuez/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@factuez/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@factuez/ui/components/table";
import {
  useResource,
  useWorkspace,
} from "../../../features/workspace/provider";
import {
  Empty,
  ErrorState,
  Loading,
  PageHeading,
  rolesText,
} from "../../../features/workspace/common";
import type { ManagedUser, Role } from "../../../features/workspace/types";
import { ListPagination, pageWindow } from "../../../features/workspace/list-pagination";
import { UserExtraPermissions } from "../../../features/workspace/user-extra-permissions";
type Form = {
  username: string;
  fullName: string;
  password: string;
  active: boolean;
  roles: string[];
  branchIds: string[];
  emissionPointIds: string[];
  series: string[];
};
const blank = (): Form => ({
  username: "",
  fullName: "",
  password: "",
  active: true,
  roles: [],
  branchIds: [],
  emissionPointIds: [],
  series: [],
});
const toggle = (values: string[], id: string) =>
  values.includes(id)
    ? values.filter((value) => value !== id)
    : [...values, id];
function Choice({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm ${checked ? "border-primary/30 bg-primary/5" : ""} ${disabled ? "opacity-60" : ""}`}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      <span>{label}</span>
    </label>
  );
}
export default function UsersPage() {
  const { api, catalog, branchId, can, setDirty, user: actor } = useWorkspace();
  const users = useResource<ManagedUser[]>("/api/v1/users");
  const roles = useResource<Role[]>("/api/v1/roles");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [search, branchId]);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ManagedUser>();
  const [form, setForm] = useState<Form>(blank());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => () => setDirty(false), [setDirty]);
  function close() {
    setOpen(false);
    setForm(blank());
    setError(undefined);
    setDirty(false);
  }
  function edit(user?: ManagedUser) {
    setTarget(user);
    setError(undefined);
    setForm(
      user
        ? { ...blank(), ...user, roles: user.roles.map((role) => role.code) }
        : { ...blank(), branchIds: branchId ? [branchId] : [] },
    );
    setOpen(true);
  }
  function change(patch: Partial<Form>) {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  }
  const choices =
    catalog?.emissionPoints.filter((point) =>
      form.branchIds.includes(point.branchId),
    ) ?? [];
  const seriesChoices = choices
    .filter((point) => form.emissionPointIds.includes(point.id))
    .flatMap((point) =>
      point.series.map((counter) => ({ ...counter, point: point.code })),
    );
  function branchToggle(id: string) {
    const selected = toggle(form.branchIds, id);
    const points =
      catalog?.emissionPoints.filter(
        (point) =>
          selected.includes(point.branchId) &&
          form.emissionPointIds.includes(point.id),
      ) ?? [];
    change({
      branchIds: selected,
      emissionPointIds: points.map((point) => point.id),
      series: form.series.filter((series) =>
        points.some((point) =>
          point.series.some((counter) => counter.id === series),
        ),
      ),
    });
  }
  function pointToggle(id: string) {
    const selected = toggle(form.emissionPointIds, id);
    change({
      emissionPointIds: selected,
      series: form.series.filter((series) =>
        choices.some(
          (point) =>
            selected.includes(point.id) &&
            point.series.some((counter) => counter.id === series),
        ),
      ),
    });
  }
  async function save() {
    setSaving(true);
    setError(undefined);
    const assignments = {
      active: form.active,
      roles: form.roles,
      branchIds: form.roles.includes("ADMIN") ? [] : form.branchIds,
      emissionPointIds: form.roles.includes("ADMIN")
        ? []
        : form.emissionPointIds,
      series: form.roles.includes("ADMIN") ? [] : form.series,
    };
    try {
      if (target)
        await api(`/api/v1/users/${target.id}/access`, {
          method: "PATCH",
          body: JSON.stringify(assignments),
        });
      else {
        const { active: _active, ...access } = assignments;
        await api("/api/v1/users", {
          method: "POST",
          body: JSON.stringify({
            ...access,
            username: form.username,
            fullName: form.fullName,
            password: form.password,
          }),
        });
      }
      setNotice(
        target
          ? "Accesos actualizados. Las sesiones anteriores de esa cuenta quedaron revocadas."
          : "Usuario creado. Ya puede iniciar sesión con sus asignaciones.",
      );
      close();
      users.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }
  const filtered = users.data?.filter(
    (user) =>
      (!branchId ||
        user.roles.some((role) => role.code === "ADMIN") ||
        user.branchIds.includes(branchId)) &&
      `${user.username} ${user.fullName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const valid =
    form.roles.length > 0 &&
    (form.roles.includes("ADMIN") || form.branchIds.length > 0) &&
    (target ||
      (/^[a-zA-Z0-9._-]{3,80}$/.test(form.username) &&
        form.fullName.trim() &&
        form.password.length >= 12));
  return (
    <>
      <PageHeading
        eyebrow="Control de acceso"
        title="Usuarios"
        description="Cuentas individuales, roles y alcance explícito por sede, punto de emisión y serie."
        action={
          can("role.manage") && (
            <Button onClick={() => edit()} disabled={!roles.data}>
              <Plus className="size-4" />
              Nuevo usuario
            </Button>
          )
        }
      />
      {notice && (
        <p
          role="status"
          className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        >
          {notice}
        </p>
      )}
      <Card className="shadow-none">
        <CardContent>
          <Input
            className="mb-5 max-w-md"
            aria-label="Buscar usuarios"
            placeholder="Buscar por usuario o nombre…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {users.error ? (
            <ErrorState message={users.error} retry={users.reload} />
          ) : !users.data ? (
            <Loading />
          ) : !filtered?.length ? (
            <Empty
              title="No hay cuentas en esta vista"
              description="Cambia la sede o el texto de búsqueda."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Usuario</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Alcance</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acceso</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(pageWindow(filtered.length, page).start, pageWindow(filtered.length, page).end).map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <p className="font-medium">{user.fullName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {user.username}
                      </p>
                    </TableCell>
                    <TableCell className="space-x-1">
                      {user.roles.map((role) => (
                        <Badge
                          key={role.code}
                          variant="secondary"
                          className="mb-1"
                        >
                          {rolesText[role.code] ?? role.name}
                        </Badge>
                      ))}
                    </TableCell>
                    <TableCell className="max-w-56 text-xs text-muted-foreground">
                      {user.roles.some((role) => role.code === "ADMIN")
                        ? "Global · todas las sedes"
                        : user.branchIds
                            .map(
                              (id) =>
                                catalog?.branches.find(
                                  (branch) => branch.id === id,
                                )?.name ?? "Sede fuera de catálogo",
                            )
                            .join(", ")}
                      <p className="mt-1">
                        {user.roles.some((role) => role.code === "ADMIN")
                          ? "Sin restricción de series"
                          : `${user.emissionPointIds.length} puntos · ${user.series.length} series`}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          user.active
                            ? "text-emerald-700"
                            : "text-muted-foreground"
                        }
                      >
                        {user.active ? "Activo" : "Desactivado"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {user.editable && actor?.scope.kind === "GLOBAL" && actor.roles.includes("ADMIN") && can("role.manage") && <div className="mb-2"><UserExtraPermissions userId={user.id} fullName={user.fullName} /></div>}
                      {user.editable && can("role.manage") ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => edit(user)}
                        >
                          <Pencil className="size-3.5" />
                          Editar
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Protegido
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {filtered && <ListPagination total={filtered.length} page={page} onChange={setPage} />}
        </CardContent>
      </Card>
      {roles.error && (
        <div className="mt-4">
          <ErrorState message={roles.error} retry={roles.reload} />
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving && !value) close();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="size-5" />
              {target ? `Acceso de ${target.username}` : "Crear usuario"}
            </DialogTitle>
            <DialogDescription>
              Los permisos dependen de los roles; las asignaciones limitan dónde
              se aplican. Cambiar accesos invalida sesiones anteriores.
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={saving} className="space-y-5">
            {!target && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-username">Usuario</Label>
                  <Input
                    id="new-username"
                    autoComplete="off"
                    maxLength={80}
                    value={form.username}
                    onChange={(event) =>
                      change({ username: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-name">Nombre completo</Label>
                  <Input
                    id="new-name"
                    maxLength={160}
                    value={form.fullName}
                    onChange={(event) =>
                      change({ fullName: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="new-password">
                    Contraseña inicial · mínimo 12 caracteres
                  </Label>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={256}
                    value={form.password}
                    onChange={(event) =>
                      change({ password: event.target.value })
                    }
                  />
                </div>
              </div>
            )}
            <div>
              <p className="mb-2 text-sm font-medium">Roles de sistema</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {roles.data?.map((role) => (
                  <Choice
                    key={role.code}
                    label={rolesText[role.code] ?? role.name}
                    checked={form.roles.includes(role.code)}
                    disabled={!role.assignable || saving}
                    onChange={() =>
                      change({ roles: toggle(form.roles, role.code) })
                    }
                  />
                ))}
              </div>
            </div>
            {form.roles.includes("ADMIN") ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Administrador general tiene acceso a todas las sedes y puede
                configurar el sistema. No se restringe por puntos ni series.
              </div>
            ) : (
              <>
                <div>
                  <p className="mb-2 text-sm font-medium">Sedes autorizadas</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {catalog?.branches.map((branch) => (
                      <Choice
                        key={branch.id}
                        checked={form.branchIds.includes(branch.id)}
                        label={`${branch.name} · ${catalog?.companies.find((company) => company.id === branch.companyId)?.ruc ?? "RUC sin configurar"}`}
                        onChange={() => branchToggle(branch.id)}
                        disabled={saving}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium">Puntos de emisión</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {choices.map((point) => (
                      <Choice
                        key={point.id}
                        checked={form.emissionPointIds.includes(point.id)}
                        label={`${point.code} · ${point.name}`}
                        onChange={() => pointToggle(point.id)}
                        disabled={saving}
                      />
                    ))}
                  </div>
                  {!choices.length && (
                    <p className="text-xs text-muted-foreground">
                      Selecciona una sede con puntos disponibles.
                    </p>
                  )}
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium">Series habilitadas</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {seriesChoices.map((counter) => (
                      <Choice
                        key={counter.id}
                        checked={form.series.includes(counter.id)}
                        label={`${counter.series} · ${counter.point}`}
                        onChange={() =>
                          change({
                            series: toggle(form.series, counter.id),
                          })
                        }
                        disabled={saving}
                      />
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Sin puntos y series asignados, la cuenta no puede emitir ni
                    consultar documentos. No significa acceso total.
                  </p>
                </div>
              </>
            )}
            {target && (
              <Choice
                label="Cuenta activa"
                checked={form.active}
                onChange={() => change({ active: !form.active })}
                disabled={saving}
              />
            )}
          </fieldset>
          {error && <ErrorState message={error} />}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={close}>
              Cancelar
            </Button>
            <Button disabled={saving || !valid} onClick={() => void save()}>
              {saving && <LoaderCircle className="size-4 animate-spin" />}
              {target ? "Guardar accesos" : "Crear usuario"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
