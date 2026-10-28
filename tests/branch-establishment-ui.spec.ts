import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyMasterDraft, masterCommand, masterDraftError, masterDraftFor } from '../apps/web-pwa/features/workspace/station-admin-model';
import type { StationAdminCatalog } from '../packages/contracts/src/station-admin';

const edit = { kind: 'branch', mode: 'edit', targetId: 'SYNTHETIC_BRANCH', revision: 7 } as const;
const draft = { ...emptyMasterDraft, companyId: '1', code: 'SEDE_LOCAL', name: 'Sede sintética', establishmentCode: '0042' };
const catalog: StationAdminCatalog = { version: 'factuez.station-admin.v1', capabilities: { betaOnly: false, softDelete: true, counterEditing: false },
  companies: [], branches: [{ id: 'SYNTHETIC_BRANCH', companyId: 1, code: 'SEDE_LOCAL', name: 'Sede sintética', address: null,
    establishmentCode: '0042', active: true, effectiveActive: true, revision: 7, pointCount: 2, openShiftCount: 0 }], emissionPoints: [], series: [] };
describe('Formulario y expansión de establecimiento SUNAT', () => {
  it('crear y editar sede envía código independiente, conserva ceros y CAS sin owner transfer', () => {
    expect(masterDraftError(edit, draft)).toBeUndefined();
    expect(masterCommand(edit, draft).body).toMatchObject({ expectedRevision: 7, establishmentCode: '0042', code: 'SEDE_LOCAL' });
    expect(masterCommand(edit, draft).body).not.toHaveProperty('companyId');
    expect(masterCommand({ kind: 'branch', mode: 'create' }, draft).body).toMatchObject({ companyId: 1, establishmentCode: '0042' });
  });
  it('precarga y permite borrar enviando null explícito, sin valor por defecto', () => {
    expect(masterDraftFor(edit, catalog).establishmentCode).toBe('0042');
    const blank = { ...draft, establishmentCode: '' };
    expect(masterDraftError(edit, blank)).toBeUndefined();
    expect(masterCommand(edit, blank).body).toHaveProperty('establishmentCode', null);
    expect(masterDraftFor({ kind: 'branch', mode: 'create' }, catalog).establishmentCode).toBe('');
    expect(masterDraftFor(edit, { ...catalog, branches: [{ ...catalog.branches[0], establishmentCode: null }] }).establishmentCode).toBe('');
  });
  it.each(['123', '12345', 'CAJA01', ' 0042', '0042 ', '0042\n', '１２３４'])('bloquea formato inválido %j antes de enviar', establishmentCode => {
    expect(masterDraftError(edit, { ...draft, establishmentCode })).toContain('4 dígitos');
  });
  it('el código de establecimiento pertenece sólo a sede y no se manda en otras acciones', () => {
    for (const kind of ['point', 'issuer', 'series', 'assign'] as const)
      expect(masterCommand({ ...edit, kind }, draft).body).not.toHaveProperty('establishmentCode');
    for (const mode of ['deactivate', 'reactivate'] as const)
      expect(masterCommand({ ...edit, mode }, draft).body).not.toHaveProperty('establishmentCode');
  });
  it('la expansión sólo añade nullable con check de cuatro dígitos sin default ni backfill', () => {
    const sql = readFileSync(new URL('../services/billing-service/prisma/branch-establishment-expand.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/ALTER TABLE public\."Branch"/);
    expect(sql).toMatch(/ADD COLUMN "establishmentCode" VARCHAR\(4\)/);
    expect(sql).toContain('"establishmentCode" IS NULL');
    expect(sql).toContain("'^[0-9]{4}$'");
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM|SET DEFAULT|SET NOT NULL)\b/i);
  });
});
