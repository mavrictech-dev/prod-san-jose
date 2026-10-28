import { ServiceUnavailableException } from '@nestjs/common';

/** Sólo indisponibilidad local explícita; nunca integridad, certificados o autorización. */
export class LocalPreparationUnavailableError extends ServiceUnavailableException {}

export function isRetryableLocalPreparationError(error: unknown): error is LocalPreparationUnavailableError {
  return error instanceof LocalPreparationUnavailableError;
}

/** Total de intentos, incluido el inicial. */
export const LOCAL_PREPARATION_MAX_ATTEMPTS = 3;

/** Intento recién consumido: 2 s, 4 s, 8 s como máximo. */
export function localPreparationRetryDelay(attempt: number): number {
  const exponent = Number.isFinite(attempt) ? Math.max(0, Math.min(2, Math.trunc(attempt) - 1)) : 2;
  return 2000 * 2 ** exponent;
}
