import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { financialDemo, FINANCIAL_DEMO_SCENARIOS } from '../services/sunat-service/src/application/fiscal-financial-demo';
import { FiscalFinancialPreviewController } from '../services/sunat-service/src/fiscal-financial-preview.controller';
describe('laboratorio financiero con fixtures fijos, sin registro ni credenciales', () => {
  it.each(FINANCIAL_DEMO_SCENARIOS)('escenario %s conserva límites locales', scenario => {
    const result = financialDemo(scenario);
    expect(result).toMatchObject({ source: 'FIXED_SYNTHETIC_FIXTURE', simulationOnly: true, localOnly: true,
      fiscalWrites: 0, certificateAccess: false, transmissionAuthorized: false, evidenceAuthenticityVerified: false, originalPreserved: true, originalPayableAmount: '236.00' });
    if (scenario === 'STALE_VERSION') expect(result.result).toEqual({ ok: false, code: 'STALE_VERSION' });
    else expect(result.result.ok, JSON.stringify(result.result)).toBe(true);
  });
  it('NC reduce neto simulado sin mutar importe original; ND no amplía capacidad', () => {
    const credit = financialDemo('CREDIT_ACCEPTED'), debit = financialDemo('DEBIT_ACCEPTED');
    if (!credit.result.ok || !debit.result.ok) throw new Error('fixture invalid');
    expect(credit.result.currentVersion.net.payableAmount).toBe('118.00');
    expect(credit.originalPayableAmount).toBe('236.00'); expect(credit.result.financialPayableAmount).toBe('236.00');
    expect(debit.result.currentVersion.net.payableAmount).toBe('259.60'); expect(debit.result.currentVersion.creditCapacity.payableAmount).toBe('236.00');
  });
  it.each(['CDR_UNVERIFIED', 'REJECTED'] as const)('%s no modifica versión ni neto', scenario => {
    const { result } = financialDemo(scenario); if (!result.ok) throw new Error('fixture invalid');
    expect(result.versionCount).toBe(1); expect(result.currentVersion.net.payableAmount).toBe('236.00');
  });
  it('replay no aplica dos veces y VOID conserva importes', () => {
    const replay = financialDemo('REPLAY'), voided = financialDemo('VOID');
    if (!replay.result.ok || !voided.result.ok) throw new Error('fixture invalid');
    expect(replay.result.outcomes).toEqual(['APPLIED', 'DUPLICATE']); expect(replay.result.versionCount).toBe(2);
    expect(voided.result.currentVersion.state).toBe('VOIDED'); expect(voided.result.financialPayableAmount).toBe('236.00');
  });
  it.each([null, {}, [], { scenario: 'PRODUCTION' }, { scenario: 'VOID', environment: 'PRODUCTION' },
    { scenario: 'CREDIT_ACCEPTED', issuerRuc: '20615878481' }, { scenario: 'VOID', evidence: { officialCdr: true } }])('endpoint no acepta datos privados, reales o claims %#', input => {
    expect(() => new FiscalFinancialPreviewController().preview(input)).toThrow('Seleccione un escenario ficticio');
  });
});
