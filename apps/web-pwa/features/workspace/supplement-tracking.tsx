"use client";
import { RefreshCw, Workflow } from 'lucide-react';
import { Button } from '@factuez/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@factuez/ui/components/table';
import { ErrorState, Loading } from './common';
import { useResource } from './provider';
type Tracking = { documentId: string; environment: 'BETA'; readOnly: true; financialProjectionApplied: false;
  transmissionAuthorized: false; items: { id: string; kind: '07' | '08' | 'RC' | 'RA'; reference: string;
    recordedStatus: string; phase: string | null; attempt: number | null; completedAt: string | null;
    requestedAction: string; snapshotSha256: string; fiscalEffectsAppliedByThisView: false }[] };
export function SupplementTracking({ documentId }: { documentId: string }) {
  const resource = useResource<Tracking>(`/api/v1/fiscal-evidence/${documentId}`, true);
  const data = resource.data;
  const valid = data && data.documentId === documentId && data.environment === 'BETA' && data.readOnly === true &&
    data.financialProjectionApplied === false && data.transmissionAuthorized === false && Array.isArray(data.items) && data.items.length <= 300;
  return <Card className="mb-6 shadow-none">
    <CardHeader className="flex flex-row items-start justify-between gap-4">
      <div className="space-y-2"><CardTitle className="flex items-center gap-2"><Workflow className="size-5" /> Notas, resúmenes y bajas · Seguimiento Beta</CardTitle>
        <CardDescription>Versiones y solicitudes vinculadas a este comprobante. Consulta sin modificar importes ni numeración.</CardDescription></div>
      <Button variant="outline" size="sm" onClick={resource.reload} aria-label="Actualizar seguimiento"><RefreshCw className="size-4" /></Button>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        Un estado registrado o respuesta 0 no acredita confianza de la firma del CDR. Esta consulta no confirma aceptación fiscal ni ejecuta anulaciones. Producción permanece bloqueada.
      </p>
      {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !data ? <Loading /> : !valid ?
        <ErrorState message="Respuesta de seguimiento inconsistente; solicite revisión." /> : !data.items.length ?
          <p className="text-sm text-muted-foreground">No hay notas o lotes fiscales vinculados. Las pruebas del emulador se muestran en su bloque QA separado.</p> :
          <Table><TableHeader><TableRow><TableHead>Referencia</TableHead><TableHead>Solicitud</TableHead><TableHead>Estado registrado</TableHead><TableHead>Transporte</TableHead><TableHead>Versión</TableHead></TableRow></TableHeader>
            <TableBody>{data.items.map(item => <TableRow key={`${item.kind}:${item.id}`}>
              <TableCell className="font-medium">{item.reference}<span className="mt-1 block text-xs text-muted-foreground">{item.kind}</span></TableCell>
              <TableCell>{item.requestedAction}</TableCell>
              <TableCell className="text-xs">{item.recordedStatus}</TableCell>
              <TableCell className="text-xs"><span className={item.phase === 'CDR_UNVERIFIED' || item.phase === 'UNKNOWN' ? 'font-medium text-amber-700 dark:text-amber-300' : ''}>{item.phase ?? 'Sin transporte reservado'}</span>
                {item.attempt !== null && <span className="mt-1 block text-muted-foreground">Intento {item.attempt}</span>}</TableCell>
              <TableCell className="max-w-40 break-all font-mono text-[10px]">{item.snapshotSha256}</TableCell>
            </TableRow>)}</TableBody>
          </Table>}
    </CardContent>
  </Card>;
}
