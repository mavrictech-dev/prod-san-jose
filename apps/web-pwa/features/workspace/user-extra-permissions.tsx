"use client";
import { useEffect, useState } from 'react';
import { Button } from '@factuez/ui/components/button';
import { Checkbox } from '@factuez/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import { ErrorState, Loading } from './common';
import { useResource, useWorkspace } from './provider';
type Status = { storageReady: boolean; editable: boolean; permissions: string[]; available: string[]; expectedAuthVersion: number };
const labels: Record<string,string> = { 'document.view': 'Consultar comprobantes y sus representaciones imprimibles', 'document.issue': 'Emitir comprobantes', 'document.email': 'Enviar comprobantes por correo', 'report.view': 'Consultar resumen y reportes', 'report.export': 'Exportar reportes', 'audit.view': 'Consultar auditoría', 'shift.open': 'Abrir turno', 'shift.close': 'Cerrar turno' };
export function UserExtraPermissions({ userId, fullName }: { userId: string; fullName: string }) {
  const [open, setOpen] = useState(false);
  return <><Button size="sm" variant="outline" onClick={() => setOpen(true)}>Permisos extra</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Permisos adicionales de {fullName}</DialogTitle><DialogDescription>Se suman a los permisos del rol, únicamente dentro de las sedes, puntos y series asignados. No convierten al usuario en administrador general. Para reducir permisos de un rol, edite su matriz o cambie la asignación.</DialogDescription></DialogHeader>{open && <ExtraForm userId={userId} close={() => setOpen(false)} />}</DialogContent></Dialog></>;
}
function ExtraForm({ userId, close }: { userId: string; close: () => void }) {
  const { api, setDirty } = useWorkspace();
  const path = `/api/v1/users/${userId}/permissions`;
  const r = useResource<Status>(path);
  const [selected, setSelected] = useState<string[] | undefined>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  useEffect(() => { setDirty(selected !== undefined); return () => setDirty(false); }, [selected, setDirty]);
  async function save() {
    if (!r.data?.editable || !selected || busy) return;
    setBusy(true); setError(undefined);
    try { await api(path, { method: 'PATCH', body: JSON.stringify({ permissions: selected, expectedAuthVersion: r.data.expectedAuthVersion }) }); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo guardar el acceso'); }
    finally { setBusy(false); }
  }
  if (r.error) return <ErrorState message={r.error} retry={r.reload} />;
  if (!r.data) return <Loading />;
  return <><div className="grid gap-2">{r.data.available.map(permission => <label key={permission} className="flex items-center gap-3 rounded-md border p-3 text-sm"><Checkbox checked={(selected ?? r.data!.permissions).includes(permission)} disabled={busy || !r.data!.editable} onCheckedChange={value => setSelected(current => value === true ? [...(current ?? r.data!.permissions).filter(code => code !== permission), permission] : (current ?? r.data!.permissions).filter(code => code !== permission))} />{labels[permission] ?? 'Permiso operativo'}</label>)}</div>{!r.data.storageReady && <p role="status" className="text-sm text-amber-800">La ampliación está preparada en el código; TI debe aplicar la tabla local de permisos antes de guardar.</p>}<p className="text-xs text-muted-foreground">Guardar revoca las sesiones anteriores de esta cuenta. Exportar reportes no autoriza emisión ni administración fiscal.</p>{error && <ErrorState message={error} />}<DialogFooter><Button variant="outline" disabled={busy} onClick={close}>Cancelar</Button><Button disabled={busy || !r.data.editable || selected === undefined} onClick={() => void save()}>Guardar permisos adicionales</Button></DialogFooter></>;
}
