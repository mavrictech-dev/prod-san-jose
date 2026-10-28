export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const IDLE_WARNING_MS = 5 * 60 * 1000;
export const IDLE_CRITICAL_MS = 30 * 1000;
export type IdlePhase = 'active' | 'warning' | 'critical' | 'expired';
export function idlePhase(deadline: number, now = Date.now()): IdlePhase {
  const remaining = deadline - now;
  return remaining <= 0 ? 'expired' : remaining <= IDLE_CRITICAL_MS ? 'critical' : remaining <= IDLE_WARNING_MS ? 'warning' : 'active';
}
export function idleSeconds(deadline: number, now = Date.now()) { return Math.max(0, Math.ceil((deadline - now) / 1000)); }
export function localIdleDeadline(status: { idleExpiresAt: number; serverNow: number }, now = Date.now()) {
  if (!Number.isSafeInteger(status.idleExpiresAt) || !Number.isSafeInteger(status.serverNow) ||
    status.idleExpiresAt < status.serverNow || status.idleExpiresAt - status.serverNow > IDLE_TIMEOUT_MS + 1000) throw new Error('Plazo de sesión inválido');
  return now + status.idleExpiresAt - status.serverNow;
}
