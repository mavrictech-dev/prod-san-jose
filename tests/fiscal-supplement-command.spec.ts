import { describe, expect, it } from 'vitest';
import { boundedSupplementJson, buildFiscalSupplementCommand, validateFiscalSupplementCommand } from '../packages/sunat-core/src/fiscal-supplement-command';
import { supplementCommandFixture, supplementUuid } from './helpers/fiscal-supplement.fixture';
describe('contrato interno Billing → SUNAT de suplementos, separado de emisión/QA', () => {
  it.each(['NOTE', 'RC', 'RA'] as const)('planifica %s sin asignar otro número ni conferir confianza', kind => {
    const fixture = supplementCommandFixture(kind), before = structuredClone(fixture.envelope);
    const result = validateFiscalSupplementCommand(fixture.command);
    expect(result).toEqual(fixture.command); expect(result.payload.operationKind).toBe(kind);
    expect(result.payload.envelopeSha256).toMatch(/^[a-f0-9]{64}$/); expect(fixture.envelope).toEqual(before);
    expect(result.producer).toBe('billing-service'); expect(JSON.stringify(result)).not.toMatch(/certificate|password|privateKey|transmissionAuthorized/);
  });
  it.each([{ producer: 'pwa' }, { eventName: 'billing.document.issued.v1' }, { eventId: 'invalid' },
    { occurredAt: '2026-10-04T18:00:00Z' }, { correlationId: 'secret' }, { extra: true }])('rechaza cabecera alterada %#', changes => {
    expect(() => validateFiscalSupplementCommand({ ...supplementCommandFixture().command, ...changes })).toThrow('Comando de suplemento BETA inválido');
  });
  it.each([{ environment: 'PRODUCTION' }, { issuerRuc: '20615878481' }, { companyId: 1 }, { branchId: supplementUuid(100) },
    { operationId: supplementUuid(101) }, { operationKind: 'RA' }, { envelopeSha256: 'b'.repeat(64) }, { secret: 'NO_REAL' }])('rechaza scope/hash/operación alterado %#', changes => {
    const { command } = supplementCommandFixture(); Object.assign(command.payload, changes);
    expect(() => validateFiscalSupplementCommand(command)).toThrow('Comando de suplemento BETA inválido');
  });
  it('contexto accessor y proxy se rechazan sin ejecutar código', () => {
    const { envelope } = supplementCommandFixture(); let accessed = false;
    const context = { eventId: supplementUuid(7), correlationId: supplementUuid(8), occurredAt: '2026-10-03T18:00:00Z' };
    Object.defineProperty(context, 'eventId', { enumerable: true, get() { accessed = true; return supplementUuid(7); } });
    expect(() => buildFiscalSupplementCommand(envelope, context)).toThrow(); expect(accessed).toBe(false);
    const proxy = new Proxy({}, { ownKeys() { accessed = true; return []; } });
    expect(() => boundedSupplementJson(proxy)).toThrow(); expect(accessed).toBe(false);
  });
  it.each([new Date(), Buffer.from('not-a-cert'), { secret: undefined }, [undefined], new Array(1), Number.NaN])('rechaza contenido no JSON %#', value => {
    expect(() => boundedSupplementJson(value)).toThrow();
  });
  it('acota tamaño/profundidad/ciclos antes de canonicalizar', () => {
    expect(() => boundedSupplementJson({ value: 'x'.repeat(16385) })).toThrow();
    expect(() => boundedSupplementJson(Array(1001).fill(0))).toThrow();
    const cyclic: any = {}; cyclic.value = cyclic; expect(() => boundedSupplementJson(cyclic)).toThrow();
    expect(() => boundedSupplementJson(Object.fromEntries(Array.from({ length: 101 }, (_, n) => [`k${n}`, n])))).toThrow();
  });
  it('normaliza sólo objetos JSON sin conservar referencia mutable', () => {
    const value = { rows: [{ amount: '0.10' }] }, clone = boundedSupplementJson(value);
    expect(clone).toEqual(value); value.rows[0].amount = '9'; expect(clone).toEqual({ rows: [{ amount: '0.10' }] });
  });
});
