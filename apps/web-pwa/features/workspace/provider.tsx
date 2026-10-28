"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Catalog, User } from "./types";
import {
  catalogForView,
  changeCatalogSelection,
  INITIAL_CATALOG_SELECTION,
  reconcileCatalogSelection,
  assignedCatalogSelection,
  type CatalogSelection,
  type CatalogView,
  type WorkspaceCatalog,
} from './catalog-model';
import { io } from 'socket.io-client';
import { idlePhase, idleSeconds, localIdleDeadline, type IdlePhase } from './session-policy';
import { SessionWarning } from './session-warning';
import { clearAdminSessionFromWorkspace } from '../b2b/admin-session-cleanup';

const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  token?: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    cache: "no-store",
    credentials: 'same-origin',
    headers: {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      Array.isArray(body?.message)
        ? body.message.join(", ")
        : (body?.message ?? `Solicitud fallida (${response.status})`),
      response.status,
    );
  return body as T;
}
type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Workspace = {
  liveStatus: 'offline' | 'connecting' | 'connected';
  liveVersion: number;
  user?: User;
  catalog?: WorkspaceCatalog;
  catalogSource: CatalogView;
  setCatalogSource: (source: CatalogView) => void;
  branchId: string;
  companyId: string;
  setCompany: (id: string) => void;
  catalogError?: string;
  sessionNotice?: string;
  restoring: boolean;
  restoreError?: string;
  retryRestore: () => void;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  setBranch: (id: string) => void;
  login: (username: string, password: string) => Promise<User>;
  logout: () => void;
  api: Api;
  apiBlob: (path: string, signal?: AbortSignal, mediaType?: "application/pdf" | "application/zip" | "application/xml" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", options?: RequestInit) => Promise<Blob>;
  can: (permission: string) => boolean;
  reloadCatalog: () => Promise<void>;
};
const Context = createContext<Workspace | null>(null);
export function landing(user: User) {
  return user.permissions.includes("report.view")
    ? "/dashboard"
    : user.permissions.includes("document.issue")
      ? "/pos"
      : "/documents";
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<{ token: string; user: User }>();
  const activeToken = useRef<string | undefined>(undefined);
  const currentSession = useRef<{ token: string; user: User } | undefined>(undefined);
  const generation = useRef(0);
  const idleDeadline = useRef(0);
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  const restoreFlight = useRef<Promise<User | undefined> | undefined>(undefined);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string>();
  const [idle, setIdle] = useState<{ phase: IdlePhase; seconds: number }>({ phase: 'active', seconds: 1800 });
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string>();
  const catalogVersion = useRef(0);
  const [catalogState, setCatalogState] = useState<{ catalog?: Catalog; selection: CatalogSelection }>({ selection: INITIAL_CATALOG_SELECTION });
  const catalog = useMemo(() => catalogState.catalog && session
    ? catalogForView(catalogState.catalog, session.user.scope, catalogState.selection.source)
    : undefined, [catalogState.catalog, catalogState.selection.source, session?.user]);
  const selection = catalog && session ? assignedCatalogSelection(catalog, session.user.scope, catalogState.selection) : { ...catalogState.selection, companyId: '', branchId: '' };
  const { companyId, branchId, source: catalogSource } = selection;
  const [catalogError, setCatalogError] = useState<string>();
  const [sessionNotice, setSessionNotice] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'offline' | 'connecting' | 'connected'>('offline');
  const [liveVersion, setLiveVersion] = useState(0);
  useEffect(() => { window.dispatchEvent(new Event('factuez:live-refresh')); }, [liveVersion]);
  const clearSession = useCallback(() => {
    clearAdminSessionFromWorkspace();
    generation.current++;
    activeToken.current = undefined;
    currentSession.current = undefined;
    idleDeadline.current = 0;
    setSession(undefined);
    setRestoring(false);
    setRestoreError(undefined);
    setIdle({ phase: 'active', seconds: 1800 });
    setContinueError(undefined);
    catalogVersion.current++;
    setCatalogState({ selection: INITIAL_CATALOG_SELECTION });
    setCatalogError(undefined);
    setDirty(false);
  }, []);
  const logout = useCallback(() => {
    clearSession();
    channel.current?.postMessage({ kind: 'logout' });
    void request('/api/v1/auth/browser-session/logout', undefined, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }, [clearSession]);
  const applyIdle = useCallback((status: { idleExpiresAt: number; serverNow: number }, broadcast = false) => {
    idleDeadline.current = localIdleDeadline(status);
    setIdle({ phase: idlePhase(idleDeadline.current), seconds: idleSeconds(idleDeadline.current) });
    if (broadcast) channel.current?.postMessage({ kind: 'activity', ...status, userId: currentSession.current?.user.sub });
  }, []);
  const restoreSession = useCallback((initial = false): Promise<User | undefined> => {
    if (restoreFlight.current) return restoreFlight.current;
    const stamp = generation.current;
    if (initial) { setRestoring(true); setRestoreError(undefined); }
    const pending = (async () => {
      try {
        const result = await request<{ accessToken: string; user: User; idleExpiresAt: number; serverNow: number }>(
          '/api/v1/auth/browser-session', undefined, { signal: AbortSignal.timeout(5000) });
        if (generation.current !== stamp) return undefined;
        applyIdle(result);
        activeToken.current = result.accessToken; currentSession.current = { token: result.accessToken, user: result.user };
        // Keep the rendered profile, not the previous transport response. The
        // latter is a fresh object after every renewal and would reset resource
        // effects on the second renewal, unmounting forms and open dialogs.
        // currentSession still retains the latest token expiry for API/renewal.
        setSession(current => {
          const previous = current?.user;
          const sameProfile = previous && previous.sub === result.user.sub && previous.username === result.user.username && previous.fullName === result.user.fullName &&
            JSON.stringify([previous.roles, previous.permissions, previous.scope]) === JSON.stringify([result.user.roles, result.user.permissions, result.user.scope]);
          return { token: result.accessToken, user: sameProfile ? previous : result.user };
        });
        setRestoring(false); setRestoreError(undefined);
        return result.user;
      } catch (error) {
        if (generation.current !== stamp) return undefined;
        if (error instanceof ApiError && error.status === 401) {
          clearSession();
          if (!initial) setSessionNotice('Su sesión venció o su acceso cambió. Inicie sesión nuevamente.');
          return undefined;
        }
        if (initial) { setRestoring(false); setRestoreError('No se pudo recuperar la sesión. Comprueba la conexión y reintenta.'); }
        throw error;
      }
    })();
    restoreFlight.current = pending;
    const settled = () => { if (restoreFlight.current === pending) restoreFlight.current = undefined; };
    void pending.then(settled, settled);
    return pending;
  }, [applyIdle, clearSession]);
  useEffect(() => { void restoreSession(true).catch(() => {}); }, [restoreSession]);
  const getAccessToken = useCallback(async () => {
    if (!currentSession.current) throw new ApiError('Inicie sesión para continuar', 401);
    if (currentSession.current.user.exp * 1000 - Date.now() <= 60000) await restoreSession();
    const token = currentSession.current?.token;
    if (!token) throw new ApiError('Inicie sesión para continuar', 401);
    return token;
  }, [restoreSession]);
  const touchSession = useCallback(async () => {
    const stamp = generation.current;
    const result = await request<{ idleExpiresAt: number; serverNow: number }>('/api/v1/auth/browser-session/activity', undefined,
      { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (generation.current !== stamp || !currentSession.current) return;
    applyIdle(result, true); setContinueError(undefined);
  }, [applyIdle]);
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return;
    const broadcast = new BroadcastChannel('factuez-session-v1'); channel.current = broadcast;
    broadcast.onmessage = event => {
      if (event.data?.kind === 'logout') { clearSession(); setSessionNotice('La sesión se cerró en otra pestaña.'); }
      if (event.data?.kind === 'login') void restoreSession().catch(() => {});
      if (event.data?.kind === 'activity' && currentSession.current?.user.sub === event.data.userId) {
        try { applyIdle(event.data); } catch { /* Invalid messages never authorize a session. */ }
      }
    };
    return () => { channel.current = undefined; broadcast.close(); };
  }, [applyIdle, clearSession, restoreSession]);
  useEffect(() => {
    if (!session) return;
    let busy = false; let confirmingExpiry = false; let lastSent = 0; let trailing: ReturnType<typeof setTimeout> | undefined;
    const send = async () => {
      if (busy || !currentSession.current || idlePhase(idleDeadline.current) === 'expired') return;
      busy = true; lastSent = Date.now();
      try { await touchSession(); }
      catch (error) { if (error instanceof ApiError && error.status === 401) { logout(); setSessionNotice('Su sesión venció por inactividad.'); } }
      finally { busy = false; }
    };
    const activity = (event: Event) => {
      if (!event.isTrusted || document.hidden || idlePhase(idleDeadline.current) !== 'active') return;
      if (Date.now() - lastSent >= 10000) void send();
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => { trailing = undefined; void send(); }, 500);
    };
    const check = () => {
      const deadline = idleDeadline.current;
      const phase = idlePhase(deadline);
      if (phase === 'expired') {
        // Otra pestaña puede seguir activa incluso si BroadcastChannel no está disponible.
        if (!confirmingExpiry) {
          confirmingExpiry = true; const stamp = generation.current;
          void restoreSession().then(user => {
            if (!user && !currentSession.current) setSessionNotice('Su sesión se cerró por inactividad o porque su acceso cambió.');
          }).catch(() => {
            if (generation.current === stamp) { logout(); setSessionNotice('Su sesión se cerró después de 30 minutos sin actividad confirmada.'); }
          }).finally(() => { confirmingExpiry = false; });
        }
        return;
      }
      setIdle({ phase, seconds: idleSeconds(deadline) });
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    for (const name of events) window.addEventListener(name, activity, { passive: true });
    const timer = window.setInterval(check, 1000);
    const visibility = () => { if (!document.hidden && currentSession.current) void restoreSession().catch(() => {}).finally(check); };
    document.addEventListener('visibilitychange', visibility);
    return () => { if (trailing) clearTimeout(trailing); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); for (const name of events) window.removeEventListener(name, activity); };
  }, [session?.user.sub, touchSession, logout, restoreSession]);
  useEffect(() => {
    if (!session) { setLiveStatus('offline'); return; }
    setLiveStatus('connecting');
    const socket = io(apiBase || window.location.origin, { path: '/socket.io', transports: ['websocket'], auth: { token: session.token }, reconnectionDelay: 2000, reconnectionDelayMax: 10000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { if (!timer) timer = setTimeout(() => { timer = undefined; setLiveVersion(value => value + 1); }, 300); };
    socket.on('connect', () => { setLiveStatus('connected'); changed(); });
    socket.on('disconnect', () => setLiveStatus('offline'));
    socket.on('connect_error', () => setLiveStatus('offline'));
    socket.on('document.changed.v1', (event: { documentId?: unknown }) => {
      if (typeof event?.documentId === 'string' && /^[0-9a-f-]{36}$/i.test(event.documentId)) changed();
    });
    socket.on('received.changed.v1', (event: { receivedDocumentId?: unknown }) => {
      if (typeof event?.receivedDocumentId === 'string' && /^[0-9a-f-]{36}$/i.test(event.receivedDocumentId)) changed();
    });
    socket.on('session.invalid', () => { logout(); setSessionNotice('Su sesión o permisos cambiaron. Inicie sesión nuevamente.'); });
    return () => { if (timer) clearTimeout(timer); socket.removeAllListeners(); socket.disconnect(); };
  }, [session, logout]);
  const api: Api = useCallback(
    async <T,>(path: string, options?: RequestInit) => {
      const token = await getAccessToken();
      try {
        return await request<T>(path, token, options);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          activeToken.current === token
        ) {
          logout();
          setSessionNotice(
            "La sesión venció o sus permisos cambiaron. Inicie sesión nuevamente.",
          );
        }
        throw error;
      }
    },
    [getAccessToken, logout],
  );
  const reloadCatalog = useCallback(async () => {
    if (!session?.user) return;
    const stamp = generation.current;
    const version = ++catalogVersion.current;
    const profile = JSON.stringify([session.user.sub, session.user.scope, session.user.roles, session.user.permissions]);
    setCatalogError(undefined);
    try {
      const next = await api<Catalog>("/api/v1/documents/catalog/issuance");
      const user = currentSession.current?.user;
      if (generation.current !== stamp || catalogVersion.current !== version || !user ||
        JSON.stringify([user.sub, user.scope, user.roles, user.permissions]) !== profile) return;
      setCatalogState(current => ({
        catalog: next,
        selection: reconcileCatalogSelection(catalogForView(next, user.scope, current.selection.source), current.selection),
      }));
    } catch (error) {
      if (generation.current === stamp && catalogVersion.current === version)
        setCatalogError(
          error instanceof Error
            ? error.message
            : "No se pudo cargar la configuración",
        );
    }
  }, [api, session?.user]);
  const setCompany = useCallback((id: string) => {
    const scope = currentSession.current?.user.scope;
    if (!scope) return;
    setDirty(false);
    setCatalogState(current => current.catalog ? {
      ...current, selection: changeCatalogSelection(current.catalog, scope, current.selection, { kind: 'company', value: id }),
    } : current);
  }, []);
  const setBranch = useCallback((id: string) => {
    const scope = currentSession.current?.user.scope;
    if (!scope) return;
    setDirty(false);
    setCatalogState(current => current.catalog ? {
      ...current, selection: changeCatalogSelection(current.catalog, scope, current.selection, { kind: 'branch', value: id }),
    } : current);
  }, []);
  const setCatalogSource = useCallback((source: CatalogView) => {
    const scope = currentSession.current?.user.scope;
    if (!scope || !['BUSINESS', 'SYNTHETIC', 'ALL'].includes(source)) return;
    setDirty(false);
    setCatalogState(current => current.catalog ? {
      ...current, selection: changeCatalogSelection(current.catalog, scope, current.selection, { kind: 'source', value: source }),
    } : current);
  }, []);
  const apiBlob = useCallback(
    async (path: string, signal?: AbortSignal, mediaType = "application/pdf", options?: RequestInit) => {
      const stamp = generation.current;
      const token = await getAccessToken();
      const response = await fetch(`${apiBase}${path}`, {
        ...options,
        cache: "no-store",
        credentials: 'same-origin',
        signal,
        headers: {
          ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
          ...options?.headers,
          Accept: mediaType,
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        if (response.status === 401 && activeToken.current === token) {
          logout();
          setSessionNotice("Su acceso cambió. Inicie sesión nuevamente.");
        }
        const body = await response.json().catch(() => null);
        throw new ApiError(
          body?.message ?? `Descarga fallida (${response.status})`,
          response.status,
        );
      }
      if (generation.current !== stamp)
        throw new ApiError("Sesión cerrada durante la descarga", 401);
      if (response.headers.get("content-type")?.split(";")[0] !== mediaType)
        throw new Error("El servidor no devolvió el formato solicitado");
      const blob = await response.blob();
      const filename = response.headers.get('content-disposition')?.match(/^attachment; filename="([A-Za-z0-9_-]{1,180}\.(?:xml|zip|pdf|xlsx))"$/)?.[1];
      return filename ? new File([blob], filename, {type: blob.type}) : blob;
    },
    [getAccessToken, logout],
  );
  useEffect(() => {
    if (session) void reloadCatalog();
  }, [session?.user, reloadCatalog]);
  useEffect(() => {
    if (!session) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const renew = async () => {
      try { await restoreSession(); } catch { /* A temporary outage is not logout; idle deadline still applies. */ }
      if (!stopped && currentSession.current) schedule();
    };
    const schedule = () => { timer = setTimeout(() => void renew(), Math.max(30000, (currentSession.current?.user.exp ?? 0) * 1000 - Date.now() - 60000)); };
    schedule();
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, restoreSession]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function login(username: string, password: string) {
    const stamp = ++generation.current;
    const result = await request<{ accessToken: string; user: User; idleExpiresAt: number; serverNow: number }>(
      "/api/v1/auth/browser-session/login",
      undefined,
      { method: "POST", body: JSON.stringify({ username, password }) },
    );
    if (generation.current !== stamp) throw new Error('El acceso cambió durante el inicio de sesión');
    const user = result.user;
    applyIdle(result);
    activeToken.current = result.accessToken;
    currentSession.current = { token: result.accessToken, user };
    setRestoring(false); setRestoreError(undefined);
    catalogVersion.current++;
    setCatalogState({ selection: INITIAL_CATALOG_SELECTION });
    setCatalogError(undefined);
    setSessionNotice(undefined);
    setSession({ token: result.accessToken, user });
    channel.current?.postMessage({ kind: 'login' });
    return user;
  }
  return (
    <Context.Provider
      value={{
        liveStatus,
        liveVersion,
        user: session?.user,
        catalog,
        catalogSource,
        setCatalogSource,
        branchId,
        companyId,
        setCompany,
        catalogError,
        sessionNotice,
        restoring,
        restoreError,
        retryRestore: () => { void restoreSession(true).catch(() => {}); },
        dirty,
        setDirty,
        setBranch,
        login,
        logout,
        api,
        apiBlob,
        can: (permission) =>
          session?.user.permissions.includes(permission) ?? false,
        reloadCatalog,
      }}
    >
      {children}
      {session && <SessionWarning phase={idle.phase} seconds={idle.seconds} busy={continuing} error={continueError}
        onLogout={logout} onContinue={() => {
          setContinuing(true); setContinueError(undefined);
          void touchSession().catch(error => {
            if (error instanceof ApiError && error.status === 401) { logout(); setSessionNotice('Su sesión venció por inactividad.'); }
            else setContinueError('No se pudo prolongar la sesión. Comprueba la conexión antes de que termine el plazo.');
          }).finally(() => setContinuing(false));
        }} />}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error("WorkspaceProvider ausente");
  return context;
}
export function useResource<T>(path: string, poll = false) {
  const { api, user } = useWorkspace();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let busy = false;
    setData(undefined);
    setError(undefined);
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(value);
          setError(undefined);
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Error de consulta",
          );
      } finally {
        busy = false;
      }
    };
    void load();
    const liveRefresh = () => void load();
    window.addEventListener('factuez:live-refresh', liveRefresh);
    const timer = poll
      ? window.setInterval(() => {
          if (!document.hidden) void load();
        }, 15000)
      : undefined;
    return () => {
      controller.abort();
      window.removeEventListener('factuez:live-refresh', liveRefresh);
      if (timer) window.clearInterval(timer);
    };
  }, [api, user, path, version, poll]);
  return { data, error, reload: () => setVersion((value) => value + 1) };
}
