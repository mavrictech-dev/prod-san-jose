import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, RequestMethod } from '../services/sunat-service/node_modules/@nestjs/common';
import { GUARDS_METADATA, HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '../services/sunat-service/node_modules/@nestjs/common/constants';
import * as adjustments from '../packages/sunat-core/src/sale-adjustments';

// Test the current source without rebuilding or rewriting the package barrel/dist.
vi.mock('@factuez/sunat-core', () => import('../packages/sunat-core/src/sale-adjustments'));
import { FiscalRulesPreviewController } from '../services/sunat-service/src/fiscal-rules-preview.controller';
import { ConfigurationGuard } from '../services/sunat-service/src/auth/configuration.guard';

const input = () => ({ environment: 'BETA', currencyCode: 'PEN', issueDate: '2026-10-02',
  lines: [{ id: '1', quantity: '1', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' }],
  globalDiscounts: [{ reasonCode: '02', factor: '0.1' }],
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Protected stateless BETA fiscal preview', () => {
  it('declares the exact POST route, guard, 200 response and no-store header', () => {
    const controller = FiscalRulesPreviewController, method = controller.prototype.preview;
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe('api/v1/fiscal-rules');
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('preview');
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([ConfigurationGuard]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(200);
    expect(Reflect.getMetadata(HEADERS_METADATA, method)).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
  });
  it('returns the exact calculation and explicit local-only assurances', () => {
    const fetch = vi.fn(() => { throw new Error('Network forbidden in calculation'); }); vi.stubGlobal('fetch', fetch);
    const body = input(), before = structuredClone(body);
    const response = new FiscalRulesPreviewController().preview(body);
    expect(response).toMatchObject({ profile: 'SALE_ADJUSTMENTS_BETA_V1', localOnly: true, transmissionAuthorized: false });
    expect(response.source.primaryUrls.every(url => new URL(url).hostname.endsWith('.sunat.gob.pe'))).toBe(true);
    expect(response.calculation.totals).toMatchObject({ taxableAmount: '90.00', igvAmount: '16.20', payableAmount: '106.20' });
    expect(response.calculation).toEqual(adjustments.calculateSaleAdjustments(body as adjustments.SaleAdjustmentsInput));
    expect(body).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['20', '30'] as const)('previews zero-tax %s without treating it as taxable', code => {
    const body = input();
    body.lines[0].taxAffectationCode = code; body.lines[0].igvRate = '0'; body.globalDiscounts = [];
    const response = new FiscalRulesPreviewController().preview(body);
    expect(response.calculation.totals.taxableAmount).toBe('0.00');
    expect(response.calculation.totals.igvAmount).toBe('0.00');
    expect(response.calculation.totals[code === '20' ? 'exoneratedAmount' : 'inaffectedAmount']).toBe('118.00');
  });
  it.each([
    null, {}, { ...input(), environment: 'PRODUCTION' }, { ...input(), currencyCode: 'EUR' },
    { ...input(), iscRate: '10' }, { ...input(), password: 'fixture-private-value' },
    { ...input(), lines: [{ ...input().lines[0], igvRate: '10.5' }] },
    { ...input(), globalDiscounts: [{ reasonCode: '02', factor: 0.1 }] },
  ])('returns sanitized BadRequest for invalid body %#', body => {
    try { new FiscalRulesPreviewController().preview(body); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
      const response = (error as BadRequestException).getResponse();
      expect(response).toMatchObject({ message: 'Datos inválidos para la vista previa fiscal BETA.' });
      expect(JSON.stringify(response)).not.toContain('fixture-private-value');
      expect(JSON.stringify(response)).not.toContain('stack');
    }
  });
  it('does not leak an unexpected private error or nested cause', () => {
    // Fault injection at the input boundary, without touching production dependencies.
    const body = new Proxy(input(), { getPrototypeOf() {
      throw new Error('fixture-private-file-password', { cause: new Error('private cause') });
    } });
    try { new FiscalRulesPreviewController().preview(body); throw new Error('Expected failure'); }
    catch (error) {
      expect((error as BadRequestException).getResponse()).toEqual({ message: 'Datos inválidos para la vista previa fiscal BETA.', code: 'PREVIEW_INVALID' });
    }
  });
});
