import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBillingSupplementActivation, BetaSupplementCommandService } from '../services/billing-service/src/application/beta-supplement-command.service';
import { supplementCommandFixture, supplementUuid } from './helpers/fiscal-supplement.fixture';

afterEach(() => vi.unstubAllEnvs());
describe('gate Billing de productor oficial, siempre cerrado', () => {
  it('el overlay del QA existente deshabilita el bootstrap demo en Billing', () => {
    const compose = readFileSync(new URL('./compose.stage2.qa.yml', import.meta.url), 'utf8');
    const billing = compose.split('  billing-service:')[1].split('  sunat-service:')[0];
    expect(billing).toContain('FACTUEZ_DEMO_SEED: "false"');
  });
  it.each(['NOTE', 'RC', 'RA'] as const)('%s no toca el repositorio aunque flags digan true', async kind => {
    vi.stubEnv('SUNAT_BETA_WORKFLOW_ENABLED', 'true'); vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    const reserve = vi.fn();
    const service = new BetaSupplementCommandService({ reserve } as never);
    await expect(service.reserve(supplementCommandFixture(kind), { userId: supplementUuid(99), scope: { kind: 'GLOBAL' } }))
      .rejects.toThrow('Productor fiscal BETA bloqueado');
    expect(reserve).not.toHaveBeenCalled();
  });
  it('rechaza antes de inspeccionar payload y no expone secretos de un getter', async () => {
    const trap = vi.fn(() => { throw new Error('PRIVATE-DATA'); });
    const value = Object.defineProperty({}, 'payload', { get: trap });
    const reserve = vi.fn();
    await expect(new BetaSupplementCommandService({ reserve } as never).reserve(value, {} as never))
      .rejects.toThrow('Productor fiscal BETA bloqueado');
    expect(trap).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it('no existe bypass de activación', () => {
    expect(() => assertBillingSupplementActivation()).toThrow('Productor fiscal BETA bloqueado');
  });
});
