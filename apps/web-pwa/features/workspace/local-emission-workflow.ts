import type { Catalog, User } from './types';

type Circuit = { ready: boolean; state: string; cdrAvailable: boolean; officialCdr: false; fiscalTransmission: false };
type Workflow = { documentId: string; localOnly: true; official: false; fiscalTransmission: false; transport: 'LOCAL_SIMULATION';
  phase: 'WAITING_LOCAL_COPY' | 'WAITING_LOCAL_VALIDATOR' | 'CIRCUIT_STARTED'; retryAfterMs?: number; circuit?: Circuit };
export type WorkflowApi = <T>(path: string, init?: RequestInit) => Promise<T>;

export function canRunLocalEmissionWorkflow(user: User | null | undefined, catalog: Catalog | undefined | null, companyId: number | undefined) {
  const company = catalog?.companies.find(item => item.id === companyId);
  return Boolean(user?.roles.includes('ADMIN') && user.scope.kind === 'GLOBAL' && user.permissions.includes('sunat.configure') &&
    catalog?.capabilities.demoData && !catalog.capabilities.fiscalTransmission && company?.environment === 'BETA' && /^00\d{9}$/.test(company.ruc));
}

function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Nunca POST /documents: errores de laboratorio no crean una segunda venta. */
export async function runLocalEmissionWorkflow(api: WorkflowApi, documentId: string, signal: AbortSignal, progress: (message: string) => void) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentId)) throw new Error('Documento local inválido');
  let validatorRetries = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    signal.throwIfAborted();
    progress('Preparando firma y paquete del laboratorio local…');
    const value = await api<Workflow>(`/api/v1/fiscal-circuit-qa/${documentId}/workflow`, { method: 'POST', body: '{}', signal });
    if (value.documentId !== documentId || value.localOnly !== true || value.official !== false || value.fiscalTransmission !== false || value.transport !== 'LOCAL_SIMULATION')
      throw new Error('Respuesta fuera del laboratorio local. No vuelva a emitir.');
    if (value.phase === 'CIRCUIT_STARTED') {
      for (let poll = 0; poll < 30; poll++) {
        const circuit = poll === 0 ? value.circuit : await api<Circuit>(`/api/v1/fiscal-circuit-qa/${documentId}`, { signal });
        if (!circuit || circuit.officialCdr !== false || circuit.fiscalTransmission !== false) throw new Error('Respuesta de circuito no verificable. Consulte el detalle.');
        if (['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'UNKNOWN', 'BLOCKED', 'POLL_LIMIT'].includes(circuit.state)) return circuit;
        progress(circuit.state === 'WAITING_TICKET' || circuit.state === 'POLLING' ? 'Consultando el mismo ticket del emulador…' : 'Circuito en cola local; esperando respuesta del emulador…');
        await sleep(2000, signal);
      }
      throw new Error('El circuito continúa en el servidor. Consulte el mismo comprobante; no lo vuelva a emitir.');
    }
    if (!['WAITING_LOCAL_COPY', 'WAITING_LOCAL_VALIDATOR'].includes(value.phase)) throw new Error('Fase local desconocida; consulte el detalle.');
    if (value.phase === 'WAITING_LOCAL_VALIDATOR' && ++validatorRetries >= 3) throw new Error('Validador local ocupado. Continúe desde el detalle del mismo comprobante.');
    progress(value.phase === 'WAITING_LOCAL_COPY' ? 'Esperando el procesamiento de Billing → SUNAT-service…' : 'Validador local ocupado; reintento limitado, sin nueva venta…');
    await sleep(Math.min(4000, Math.max(1000, value.retryAfterMs ?? 2000)), signal);
  }
  throw new Error('El comprobante quedó registrado. Consulte su detalle antes de continuar; no lo vuelva a emitir.');
}
