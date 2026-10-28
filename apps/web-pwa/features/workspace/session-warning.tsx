"use client";
import { Clock3, LoaderCircle } from 'lucide-react';
import { Button } from '@factuez/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@factuez/ui/components/dialog';
import type { IdlePhase } from './session-policy';

export function SessionWarning({ phase, seconds, busy, error, onContinue, onLogout }: {
  phase: IdlePhase; seconds: number; busy: boolean; error?: string; onContinue: () => void; onLogout: () => void;
}) {
  return <Dialog open={phase === 'warning' || phase === 'critical'}>
    <DialogContent showCloseButton={false} onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Clock3 className="size-5 text-amber-600" />{phase === 'critical' ? 'Tu sesión está a punto de cerrarse' : '¿Sigues trabajando?'}</DialogTitle>
        <DialogDescription>Por seguridad, la sesión se cierra después de 30 minutos sin actividad. Pulsa «Continuar trabajando» para mantenerla abierta.</DialogDescription>
      </DialogHeader>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        <p role={phase === 'critical' ? 'alert' : 'status'}>{phase === 'critical' ? 'Último aviso: quedan 30 segundos o menos.' : 'Aviso: quedan 5 minutos o menos.'}</p>
        <p className="mt-2 text-2xl font-semibold tabular-nums" aria-label="Tiempo restante">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" onClick={onLogout}>Cerrar sesión</Button><Button onClick={onContinue} disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin" />}Continuar trabajando</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
