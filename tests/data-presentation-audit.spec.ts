import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Auditoría de selección explícita y fuente de datos de las pantallas', () => {
  it.each([
    'apps/web-pwa/app/(workspace)/sunat-settings/page.tsx',
    'apps/web-pwa/features/workspace/smtp-settings.tsx',
  ])('%s no usa la primera empresa al consultar/guardar credenciales', file => {
    const code = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    expect(code).not.toContain('companies[0]');
    expect(code).toContain('String(');
    expect(code).toContain('=== companyId');
    expect(code).toContain('Seleccione explícitamente un emisor');
  });
  it('GRE obtiene ubigeos/unidades del servidor y no precarga una ubicación', () => {
    const code = readFileSync(new URL('../apps/web-pwa/features/workspace/gre-qa.tsx', import.meta.url), 'utf8');
    expect(code).toContain('/api/v1/gre-qa/capabilities');
    expect(code).toContain("ubigeo:''");
    expect(code).toContain('itemUnits.map');
    expect(code).not.toContain('150101');
    expect(code).not.toContain('companies.find');
  });
  it.each(['dashboard', 'documents'])('%s envía fuente explícita para listados/agregados', page => {
    const code = readFileSync(new URL(`../apps/web-pwa/app/(workspace)/${page}/page.tsx`, import.meta.url), 'utf8');
    expect(code).toContain('dataSource: catalogSource');
  });
});
