"use client";
import { useState } from 'react';
import { useResource, useWorkspace } from './provider';
import { ErrorState, Loading } from './common';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@factuez/ui/components/card';
import { Button } from '@factuez/ui/components/button';
import { Badge } from '@factuez/ui/components/badge';
import { Input } from '@factuez/ui/components/input';
import { Label } from '@factuez/ui/components/label';
import { Checkbox } from '@factuez/ui/components/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@factuez/ui/components/dialog';
type State = { ruc: string; environment: string; profile: string; supportedDocumentTypes: string[]; availableDocumentTypes?: string[]; serverEnabled: boolean; version: number; credentialRevision: number; enabled: boolean };
const confirmationText = 'ACTIVAR ENVÍOS REALES A SUNAT';
export function ProductionActivation({ companyId }: { companyId: number }) {
  const { api, catalog, reloadCatalog, can } = useWorkspace();
  const company = catalog?.companies.find(value => value.id === companyId);
  const path = `/api/v1/setup/sunat/${companyId}/PRODUCTION/dispatch`;
  const status = useResource<State>(path);
  const [includeReceipts, setIncludeReceipts] = useState(false);
  const [open, setOpen] = useState(false), [registration, setRegistration] = useState(false), [confirmation, setConfirmation] = useState('');
  const [modeOpen, setModeOpen] = useState(false), [modeConfirmation, setModeConfirmation] = useState(''), [modeRevision, setModeRevision] = useState<number>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [success, setSuccess] = useState<string>();
  async function save(enabled: boolean) {
    if (!status.data || busy) return;
    setBusy(true); setError(undefined); setSuccess(undefined);
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ enabled, expectedRevision: status.data.credentialRevision,
        expectedVersion: status.data.version, ...(enabled ? { registrationConfirmed: registration, confirmation, authorizedDocumentTypes: includeReceipts ? ['01', '03'] : ['01'] } : {}) }) });
      setSuccess(enabled ? `Autorización guardada para ${includeReceipts ? 'factura 01 y boleta 03 mediante resumen RC' : 'factura 01'}. Los documentos pendientes serán revisados por el servicio de despacho.` : 'Autorización retirada. No se iniciarán nuevos envíos para este emisor.');
      setOpen(false); setConfirmation(''); setRegistration(false); status.reload();
      window.dispatchEvent(new Event('factuez:live-refresh'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo actualizar la autorización'); }
    finally { setBusy(false); }
  }
  async function reviewEmissionMode() {
    setBusy(true); setError(undefined);
    try {
      const masters = await api<{ companies: { id: number; revision: number; environment: string }[] }>('/api/v1/stations/admin/catalog');
      const issuer = masters.companies.find(value => value.id === companyId);
      if (!issuer || issuer.environment !== 'BETA' || !Number.isSafeInteger(issuer.revision)) throw new Error('Actualice los datos del emisor antes de cambiar su ambiente.');
      setModeRevision(issuer.revision); setModeConfirmation(''); setModeOpen(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo revisar el emisor'); }
    finally { setBusy(false); }
  }
  async function changeEmissionMode() {
    if (busy || modeRevision === undefined || modeConfirmation !== 'CAMBIAR EMISOR A PRODUCCIÓN') return;
    setBusy(true); setError(undefined);
    try {
      await api(`/api/v1/stations/issuers/${companyId}/environment`, { method: 'POST', body: JSON.stringify({ expectedRevision: modeRevision, environment: 'PRODUCTION', confirmation: modeConfirmation }) });
      setModeOpen(false); setModeConfirmation(''); await reloadCatalog(); status.reload();
      setSuccess('Ambiente de emisión actualizado. Las nuevas facturas de este emisor corresponden a Producción.');
      window.dispatchEvent(new Event('factuez:live-refresh'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo cambiar el ambiente de emisión'); }
    finally { setBusy(false); }
  }
  const state = status.data;
  return <Card className="mt-6"><CardHeader><CardTitle>Autorización de envíos reales</CardTitle>
    <CardDescription>Factura 01 y habilitación opcional de boleta 03 por resumen RC · soles · venta interna con IGV 18 %.</CardDescription></CardHeader>
    <CardContent className="space-y-4">{status.error ? <ErrorState message={status.error} retry={status.reload} /> : !state ? <Loading /> : state.environment !== 'PRODUCTION' ?
      <ErrorState message="No se pudo confirmar el ambiente de la autorización." /> : <>
      <div className="flex flex-wrap gap-2"><Badge variant="outline">RUC {state.ruc}</Badge><Badge variant="outline">{state.enabled ? 'Autorización vigente' : 'Sin autorización vigente'}</Badge><Badge variant="outline">Alcance: {state.supportedDocumentTypes.join(' / ')}</Badge></div>
      {!state.serverEnabled && <p className="text-sm text-muted-foreground">El servicio de despacho de Producción no está habilitado en este servidor.</p>}
      <p className="text-sm text-muted-foreground">Autorizar el despacho no envía un comprobante de prueba. El servicio revisa el certificado, las credenciales y los documentos del emisor antes de cada envío.</p>
      <p className="text-sm">Ambiente actual de las ventas: <strong>{company?.environment === 'PRODUCTION' ? 'Producción' : 'Beta / pruebas'}</strong></p>
      {state.enabled && company?.environment === 'BETA' && can('setup.manage') && <Button variant="outline" disabled={busy} onClick={() => void reviewEmissionMode()}>Preparar este emisor para Producción</Button>}
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !state.serverEnabled} onClick={() => { setError(undefined); setIncludeReceipts(false); setRegistration(false); setConfirmation(''); setOpen(true); }}>{state.enabled ? 'Revisar alcance autorizado' : 'Autorizar envíos'}</Button>
        <Button variant="outline" disabled={busy || state.version === 0} onClick={() => void save(false)}>Suspender nuevos envíos</Button></div>
    </>}{error && <ErrorState message={error} />}{success && <p role="status" className="text-sm">{success}</p>}</CardContent>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Activar envíos reales a SUNAT</DialogTitle>
      <DialogDescription>RUC {state?.ruc}. Los documentos pendientes de este perfil podrán enviarse a Producción. Un envío realizado no se deshace al suspender la autorización.</DialogDescription></DialogHeader>
      <div className="space-y-4"><div className="flex items-start gap-3"><Checkbox id="production-registration" checked={registration} onCheckedChange={value => setRegistration(value === true)} /><Label htmlFor="production-registration">Confirmo que el emisor y su certificado están registrados y habilitados ante SUNAT.</Label></div>
      <div className="flex items-start gap-3"><Checkbox id="production-receipts" checked={includeReceipts} onCheckedChange={value => setIncludeReceipts(value === true)} /><Label htmlFor="production-receipts">Autorizo también boleta 03 mediante resumen RC de una boleta. Acepto que se procesen las boletas pendientes de este perfil con una nueva versión de autorización.</Label></div>
      <p className="text-sm">Alcance elegido: {includeReceipts ? 'Factura 01 y boleta 03 mediante RC' : 'Sólo factura 01'}. El resultado SUNAT de la boleta corresponde al RC que la incluye.</p>
      <div className="space-y-2"><Label htmlFor="production-confirmation">Escriba: {confirmationText}</Label><Input id="production-confirmation" value={confirmation} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></div>
      {error && <ErrorState message={error} />}</div><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancelar</Button>
      <Button disabled={busy || !registration || confirmation !== confirmationText} onClick={() => void save(true)}>Confirmar autorización</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={modeOpen} onOpenChange={value => { if (!busy) setModeOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Configurar ambiente de emisión</DialogTitle>
      <DialogDescription>RUC {state?.ruc}. Sólo se permite para un emisor nuevo, sin documentos ni series utilizadas. Se conserva la numeración configurada. El cambio se bloqueará si ya existe historial de pruebas.</DialogDescription></DialogHeader>
      <div className="space-y-2"><Label htmlFor="emission-mode-confirmation">Escriba: CAMBIAR EMISOR A PRODUCCIÓN</Label><Input id="emission-mode-confirmation" autoComplete="off" value={modeConfirmation} onChange={event => setModeConfirmation(event.target.value)} /></div>
      {error && <ErrorState message={error} />}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setModeOpen(false)}>Cancelar</Button><Button disabled={busy || modeConfirmation !== 'CAMBIAR EMISOR A PRODUCCIÓN'} onClick={() => void changeEmissionMode()}>Confirmar ambiente</Button></DialogFooter></DialogContent></Dialog>
  </Card>;
}
