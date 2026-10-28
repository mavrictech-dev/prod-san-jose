"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import { OnpremWorkspaceAdminHost, explicitOnpremProfile } from './onprem-admin-session-host';
import { Badge } from '@factuez/ui/components/badge';
import { Button } from '@factuez/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@factuez/ui/components/card';
import { IntegrationAdminHost, IntegrationAdminSessionProvider } from './integration-admin-host';
import {
  adminSsoServerSnapshot, createAdminBrowserClient,
  type AdminBrowserClient, type AdminBrowserDependencies, type AdminSessionSnapshot,
} from './admin-browser-client';

export interface AdminSsoSessionHostProps {
  profile?: 'SSO' | 'ONPREM';
  dependencies?: AdminBrowserDependencies;
  /** Optional explicit session for isolated SSR/model tests. */
  client?: AdminBrowserClient;
}
const subscribeNone = () => () => {};
const serverSnapshot = () => adminSsoServerSnapshot;

/** Interpret only the public failure marker; never reflect callback query data. */
export function adminSsoCallbackFailed(search: string): boolean {
  const values = new URLSearchParams(search).getAll('adminSso');
  return values.length === 1 && values[0] === 'failed';
}
export function AdminSsoCallbackNotice({ failed }: { failed: boolean }) {
  return failed ? <p className="text-sm text-muted-foreground" role="alert">No se pudo completar el inicio de sesión de administración. Verifica el acceso o vuelve a iniciar sesión.</p> : null;
}

function sessionStatus(state: AdminSessionSnapshot): string {
  if (state.phase === 'checking') return 'Verificando';
  if (state.busy) return 'Procesando sesión';
  if (state.phase === 'authenticated') return 'Sesión verificada';
  if (state.phase === 'anonymous') return 'Inicio de sesión requerido';
  if (state.phase === 'expired') return state.error === 'ACCESS_DENIED' ? 'Acceso rechazado' : 'Sesión vencida';
  if (state.phase === 'closed') return 'Sesión cerrada';
  if (state.phase === 'disabled') return state.error === 'HTTPS_REQUIRED' ? 'Requiere HTTPS'
    : state.error === 'ADMIN_BFF_DISABLED' ? 'No habilitado' : 'Sin verificar';
  return 'Sin confirmar';
}

function sessionMessage(state: AdminSessionSnapshot): string {
  if (state.phase === 'closed') return 'La sesión de administración se cerró. Vuelve a abrir el panel desde tu espacio de trabajo.';
  if (state.phase === 'checking') return 'Verificando acceso de administración…';
  if (state.phase === 'disabled') return state.error === 'HTTPS_REQUIRED'
    ? 'La administración requiere una conexión HTTPS del sitio.'
    : state.error !== 'ADMIN_BFF_DISABLED' ? 'El estado del servicio de administración aún no se ha verificado.'
    : 'La conexión de administración aún no está habilitada. TI debe configurar la sesión con verificación adicional y el acceso privado antes de gestionar integraciones.';
  if (state.phase === 'expired') return state.error === 'ACCESS_DENIED'
    ? 'El servidor rechazó la sesión o su verificación de seguridad. Inicia sesión de nuevo para verificar tus permisos.'
    : 'La sesión de administración venció. Inicia sesión de nuevo para continuar.';
  if (state.phase === 'error') {
    if (state.error === 'INVALID_AUTHORIZE_URL') return 'No se pudo validar el destino de inicio de sesión. Verifica el acceso o vuelve a intentarlo.';
    if (state.error === 'RATE_LIMITED') return 'Hay demasiadas solicitudes. Espera un momento y vuelve a intentarlo.';
    return 'No se pudo verificar o cerrar la sesión de administración. El panel permanece cerrado; verifica el acceso antes de continuar.';
  }
  return state.busy ? 'Procesando la sesión de administración…'
    : 'Inicia sesión con la cuenta autorizada para administrar integraciones B2B en BETA.';
}

/** Owns only the B2B administrator session. It never invokes the PWA login/logout.
 * A status read runs on mount or an explicit click; no focus/interval refresh can
 * replace the provider while its one-time-secret dialog is open. */
function OidcAdminSsoSessionHost({ dependencies, client: injected }: AdminSsoSessionHostProps = {}) {
  const [owned, setOwned] = useState<AdminBrowserClient | null>(null);
  const [callbackFailed, setCallbackFailed] = useState(false);
  const client = injected ?? owned;
  const state = useSyncExternalStore(
    client?.subscribe ?? subscribeNone,
    client?.getSnapshot ?? serverSnapshot,
    injected?.getSnapshot ?? serverSnapshot,
  );
  useEffect(() => {
    const browser = dependencies?.window ?? (typeof window === 'undefined' ? undefined : window);
    setCallbackFailed(adminSsoCallbackFailed(browser?.location.search ?? ''));
    const runtime = injected ?? createAdminBrowserClient(dependencies);
    if (!injected) setOwned(runtime);
    void runtime.status().catch(() => {});
    return () => runtime.close();
  }, [dependencies, injected]);

  const run = (action: 'status' | 'start' | 'logout') => {
    if (client) void client[action]().catch(() => {});
  };
  const authenticated = state.phase === 'authenticated' && client !== null;
  const canStart = state.enabled && ['anonymous', 'expired', 'error'].includes(state.phase);
  const canVerify = state.phase !== 'closed' && state.error !== 'HTTPS_REQUIRED';
  return <div className="space-y-4">
    <Card aria-busy={state.busy || state.phase === 'checking'}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Integraciones B2B</CardTitle>
          <Badge variant="outline">BETA</Badge>
        </div>
        <CardDescription>Aplicaciones y permisos · acceso mediante una sesión SSO independiente.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <dt className="font-medium">Acceso al servicio</dt>
          <dd><Badge variant="outline">{sessionStatus(state)}</Badge></dd>
        </dl>
        {!authenticated && <AdminSsoCallbackNotice failed={callbackFailed} />}
        <p className="text-sm text-muted-foreground" role={state.error && state.phase !== 'disabled' ? 'alert' : 'status'}>
          {authenticated ? 'Acceso de administración verificado. La consulta de aplicaciones comprueba el servicio de gestión.' : sessionMessage(state)}
        </p>
        <div className="flex flex-wrap gap-2">
          {authenticated && <Button type="button" variant="outline" disabled={state.busy} onClick={() => run('logout')}>Cerrar sesión de administración</Button>}
          {canStart && <Button type="button" disabled={state.busy} onClick={() => run('start')}>Iniciar sesión de administración</Button>}
          {!authenticated && canVerify && <Button type="button" variant="outline" disabled={!client || state.busy || state.phase === 'checking'} onClick={() => run('status')}>
            {state.phase === 'error' ? 'Reintentar verificación' : 'Verificar acceso'}
          </Button>}
        </div>
      </CardContent>
    </Card>
    {authenticated && <IntegrationAdminSessionProvider client={client}><IntegrationAdminHost /></IntegrationAdminSessionProvider>}
  </div>;
}


/** Explicit ONPREM selection requires a separately confirmed enabled server
 * status. SSO errors never select a second authority automatically. */
export function AdminSsoSessionHost(props: AdminSsoSessionHostProps = {}) {
  const profile = props.profile ?? process.env.NEXT_PUBLIC_B2B_ADMIN_PROFILE;
  return explicitOnpremProfile(profile) ? <OnpremWorkspaceAdminHost /> : <OidcAdminSsoSessionHost {...props} />;
}