import { describe, expect, it } from 'vitest';

import { addMoney, calculateTaxLine } from './tax';

describe('cálculo fiscal exacto', () => {
  it('conserva el caso legado de S/ 118 con IGV incluido', () => {
    expect(calculateTaxLine({ quantity: '1', unitPriceWithTax: '118', igvRate: '18' })).toEqual({
      lineExtensionAmount: '100.00',
      igvAmount: '18.00',
      totalAmount: '118.00',
      unitValue: '100.000000',
    });
  });

  it('calcula cantidades fraccionarias de combustible sin floats', () => {
    const line = calculateTaxLine({ quantity: '2.500000', unitPriceWithTax: '4.720000', igvRate: '18.00' });
    expect(line.totalAmount).toBe('11.80');
    expect(line.lineExtensionAmount).toBe('10.00');
    expect(line.igvAmount).toBe('1.80');
  });

  it('suma importes monetarios exactamente', () => {
    expect(addMoney(['0.10', '0.20', '11.80'])).toBe('12.10');
  });
});
