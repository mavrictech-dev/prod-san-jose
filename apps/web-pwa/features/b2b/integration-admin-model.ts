import { B2bEnabledIdentityScopes, b2bBindingKey, validB2bBinding, type B2bBinding } from '@factuez/contracts/b2b-security';

export type { B2bBinding };
export interface IntegrationAdminClient {
  id: string;
  label: string;
  kind: 'SERVICE' | 'USER';
  enabled: boolean;
  revision: number;
  scopes: string[];
  bindings: B2bBinding[];
  oidcClientId: string | null;
}
export interface IntegrationAdminCreate {
  label: string;
  kind: 'SERVICE' | 'USER';
  oidcClientId?: string;
  scopes: string[];
  bindings: B2bBinding[];
}
export interface IntegrationAdminUpdate {
  expectedRevision: number;
  enabled?: boolean;
  scopes?: string[];
  bindings?: B2bBinding[];
}
export interface IntegrationAdminPage {
  items: IntegrationAdminClient[];
  nextAfter: string | null;
  hasMore: boolean;
}
/** The host supplies a session-bound port. Every call must authorize on the server,
 * including live step-up for mutations. The panel never supplies authority claims.
 * Keep this port identity stable within a session and replace it when the session changes.
 * Mutation responses containing clientSecret must not be retained by the port.
 */
export interface IntegrationAdminPort {
  list(query: { after?: string; limit: number }): Promise<IntegrationAdminPage>;
  read(id: string): Promise<IntegrationAdminClient>;
  create(input: IntegrationAdminCreate): Promise<{ client: IntegrationAdminClient; clientSecret?: string }>;
  update(id: string, input: IntegrationAdminUpdate): Promise<{ client: IntegrationAdminClient }>;
  rotate(id: string, input: { expectedRevision: number }): Promise<{ client: IntegrationAdminClient; clientSecret?: string }>;
}
export type IntegrationAdminCommand =
  | { action: 'create'; input: IntegrationAdminCreate }
  | { action: 'update'; id: string; input: IntegrationAdminUpdate }
  | { action: 'rotate'; id: string; input: { expectedRevision: number } };

export const integrationAdminScopes: readonly string[] = B2bEnabledIdentityScopes;
export function integrationAdminError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { status?: unknown; code?: unknown } : {};
  if (value.status === 409 || value.code === 'REVISION_CONFLICT') return 'La integración cambió en otra sesión. Revisa la revisión actual antes de volver a confirmar.';
  if (value.code === 'STEP_UP_REQUIRED') return 'Se requiere una verificación adicional de identidad. Complétala en tu sesión y vuelve a intentarlo.';
  if (value.status === 401) return 'La sesión no está vigente. Inicia sesión de nuevo para continuar.';
  if (value.status === 403) return 'El servidor no autorizó la operación. Comprueba tus permisos y la verificación de identidad.';
  if (value.status === 404) return 'La integración ya no está disponible en tu alcance.';
  if (value.status === 400) return 'El servidor rechazó la configuración. Revisa los permisos y los alcances seleccionados.';
  if (value.status === 429) return 'Hay demasiadas solicitudes. Espera un momento antes de intentarlo de nuevo.';
  return 'No se pudo completar la consulta u operación. Actualiza para comprobar el estado antes de volver a intentarlo.';
}

export function integrationAdminInputError(input: IntegrationAdminCreate): string | undefined {
  if (!input.label.trim() || input.label.length > 120 || /[\x00-\x1f\x7f]/.test(input.label)) return 'Escribe un nombre de hasta 120 caracteres.';
  if (input.kind !== 'SERVICE' && input.kind !== 'USER') return 'Selecciona el tipo de integración.';
  if (input.kind === 'USER' && !/^[A-Za-z0-9_-]{1,120}$/.test(input.oidcClientId ?? '')) return 'Escribe un identificador OIDC válido (letras, números, guion o guion bajo).';
  if (input.kind === 'SERVICE' && input.oidcClientId !== undefined) return 'Una integración de servicio no utiliza un identificador OIDC.';
  if (!input.scopes.length || input.scopes.some(scope => !integrationAdminScopes.includes(scope)) || new Set(input.scopes).size !== input.scopes.length) return 'Selecciona al menos un permiso válido, sin duplicados.';
  if (input.scopes.includes('b2b:artifacts:read') && !input.scopes.includes('b2b:documents:read')) return 'La lectura de archivos requiere lectura de documentos.';
  if (input.scopes.includes('b2b:received:artifacts:read') && !input.scopes.includes('b2b:received:read')) return 'La lectura de archivos recibidos requiere lectura de recibidos.';
  if (!input.bindings.length || input.bindings.length > 500 || !input.bindings.every(validB2bBinding)) return 'Completa al menos un alcance BETA: emisor, RUC de 11 dígitos, sede, punto y serie válidos.';
  if (new Set(input.bindings.map(b2bBindingKey)).size !== input.bindings.length) return 'Hay alcances duplicados. Conserva una sola fila por combinación.';
}

// Explicit projection keeps all response extras, including secrets, out of view state.
export function integrationAdminMetadata(client: IntegrationAdminClient): IntegrationAdminClient {
  if (!client || typeof client.id !== 'string' || typeof client.label !== 'string' ||
    !['SERVICE', 'USER'].includes(client.kind) || typeof client.enabled !== 'boolean' ||
    !Number.isSafeInteger(client.revision) || client.revision < 1 ||
    !Array.isArray(client.scopes) || !client.scopes.every(scope => typeof scope === 'string') ||
    !Array.isArray(client.bindings) || !client.bindings.every(validB2bBinding) ||
    !(client.oidcClientId === null || typeof client.oidcClientId === 'string')) throw new Error('INVALID_METADATA');
  return {
    id: client.id, label: client.label, kind: client.kind, enabled: client.enabled, revision: client.revision,
    scopes: [...client.scopes], oidcClientId: client.oidcClientId,
    bindings: client.bindings.map(binding => ({ issuerId: binding.issuerId, issuerRuc: binding.issuerRuc,
      environment: binding.environment, branchId: binding.branchId, pointId: binding.pointId,
      seriesId: binding.seriesId, documentType: binding.documentType })),
  };
}
export interface IntegrationAdminState {
  items: IntegrationAdminClient[];
  selected: IntegrationAdminClient | null;
  nextAfter: string | null;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string;
  notice: string;
}

/** Metadata-only local view model. No response cache and no secret in snapshots. */
export class IntegrationAdminController {
  private state: IntegrationAdminState = { items: [], selected: null, nextAfter: null, hasMore: false, loading: true, loaded: false, error: '', notice: '' };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private revealTicket = 0;
  private active = false;
  private working = false;
  constructor(private readonly port: IntegrationAdminPort) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<IntegrationAdminState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  start() { this.active = true; this.working = false; ++this.epoch; void this.load(); }
  dispose() { this.active = false; this.working = false; ++this.epoch; this.cancelReveal(); }
  cancelReveal = () => { ++this.revealTicket; };
  private current(epoch: number) { return this.active && epoch === this.epoch; }
  private async page(after?: string) {
    const result = await this.port.list({ ...(after ? { after } : {}), limit: 25 });
    if (!result || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean' ||
      !(result.nextAfter === null || typeof result.nextAfter === 'string') ||
      (result.hasMore && (!result.nextAfter || result.nextAfter === after))) throw new Error('INVALID_PAGE');
    return { items: result.items.map(integrationAdminMetadata), nextAfter: result.nextAfter, hasMore: result.hasMore };
  }
  async load(more = false) {
    if (this.working || !this.active) return;
    const after = more && this.state.hasMore ? this.state.nextAfter : undefined;
    if (more && !after) return;
    const epoch = this.epoch;
    this.working = true; this.publish({ loading: true, error: '', notice: '' });
    try {
      const page = await this.page(after ?? undefined);
      if (!this.current(epoch)) return;
      const items = after ? [...new Map([...this.state.items, ...page.items].map(client => [client.id, client])).values()] : page.items;
      this.publish({ ...page, items, loaded: true });
      if (!more && this.state.selected) {
        const selected = integrationAdminMetadata(await this.port.read(this.state.selected.id));
        if (this.current(epoch)) this.publish({ selected });
      }
    } catch (error) {
      if (this.current(epoch)) this.publish({ error: integrationAdminError(error), selected: null, ...(!more ? { items: [], loaded: false, hasMore: false, nextAfter: null } : {}) });
    } finally { if (this.current(epoch)) { this.working = false; this.publish({ loading: false }); } }
  }
  async inspect(id: string) {
    if (this.working || !this.active) return;
    const epoch = this.epoch;
    this.working = true; this.publish({ selected: null, loading: true, error: '', notice: '' });
    try {
      const selected = integrationAdminMetadata(await this.port.read(id));
      if (this.current(epoch)) this.publish({ selected });
    } catch (error) { if (this.current(epoch)) this.publish({ error: integrationAdminError(error) }); }
    finally { if (this.current(epoch)) { this.working = false; this.publish({ loading: false }); } }
  }
  async confirm(command: IntegrationAdminCommand, reveal: (secret: string) => void, complete: () => void) {
    if (this.working || !this.active) return;
    const epoch = this.epoch, ticket = ++this.revealTicket;
    this.working = true; this.publish({ loading: true, error: '', notice: '' });
    let selectedId = command.action === 'create' ? null : command.id;
    try {
      const result = command.action === 'create' ? await this.port.create(command.input) : command.action === 'rotate'
        ? await this.port.rotate(command.id, command.input) : await this.port.update(command.id, command.input);
      if (!this.current(epoch)) return;
      const client = integrationAdminMetadata(result.client);
      selectedId = client.id;
      this.publish({ selected: client, items: this.state.items.map(row => row.id === client.id ? client : row), notice: 'Operación completada. Se actualizó la revisión de la integración.' });
      if (ticket === this.revealTicket) {
        if (command.action !== 'update' && client.kind === 'SERVICE' && 'clientSecret' in result && typeof result.clientSecret === 'string' && result.clientSecret) reveal(result.clientSecret);
        else {
          if (command.action !== 'update' && client.kind === 'SERVICE') this.publish({ error: 'El cambio se completó, pero no se recibió el secreto. No se puede recuperar; consulta la revisión actual antes de solicitar una nueva rotación.' });
          complete();
        }
      }
    } catch (error) {
      if (!this.current(epoch)) return;
      this.publish({ error: integrationAdminError(error), selected: null });
      if (ticket === this.revealTicket) complete();
    } finally {
      // Closing a pending dialog cancels revelation, never the server mutation.
      // Re-read after success OR uncertain failure; never retry a mutation automatically.
      if (this.current(epoch)) {
        const [page, detail] = await Promise.allSettled([this.page(), selectedId ? this.port.read(selectedId).then(integrationAdminMetadata) : Promise.resolve(null)]);
        if (this.current(epoch)) {
          this.publish(page.status === 'fulfilled' ? { ...page.value, loaded: true } : { items: [], loaded: false, hasMore: false, nextAfter: null });
          this.publish({ selected: detail.status === 'fulfilled' ? detail.value : null });
          if ((page.status === 'rejected' || detail.status === 'rejected') && !this.state.error) this.publish({ error: 'La operación terminó, pero no se pudo actualizar el estado. Pulsa Actualizar antes de continuar.' });
          this.working = false; this.publish({ loading: false });
        }
      }
    }
  }
}

