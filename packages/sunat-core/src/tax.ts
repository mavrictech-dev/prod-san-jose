const INPUT_SCALE = 6;
const MONEY_SCALE = 2;

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

export function parseDecimal(value: string, scale = INPUT_SCALE): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Decimal inválido: ${value}`);
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = value.replace('-', '').split('.');
  if (fraction.length > scale) throw new Error(`Máximo ${scale} decimales: ${value}`);
  const scaled = BigInt(integer) * pow10(scale) + BigInt(fraction.padEnd(scale, '0'));
  return negative ? -scaled : scaled;
}

export function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new Error('Sólo se admiten importes no negativos');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function formatScaled(value: bigint, scale: number): string {
  const base = pow10(scale);
  const integer = value / base;
  const fraction = (value % base).toString().padStart(scale, '0');
  return scale === 0 ? integer.toString() : `${integer}.${fraction}`;
}

export interface TaxLineInput {
  quantity: string;
  unitPriceWithTax: string;
  igvRate: string;
}

export interface TaxLineResult {
  lineExtensionAmount: string;
  igvAmount: string;
  totalAmount: string;
  unitValue: string;
}

export function calculateTaxLine(input: TaxLineInput): TaxLineResult {
  const quantity = parseDecimal(input.quantity);
  const unitPrice = parseDecimal(input.unitPriceWithTax);
  const rateBasisPoints = parseDecimal(input.igvRate, 2);
  const grossCents = roundDivide(quantity * unitPrice, pow10(INPUT_SCALE * 2 - MONEY_SCALE));
  const netCents = roundDivide(grossCents * 10_000n, 10_000n + rateBasisPoints);
  const taxCents = grossCents - netCents;
  const unitNet = roundDivide(unitPrice * 10_000n, 10_000n + rateBasisPoints);

  return {
    lineExtensionAmount: formatScaled(netCents, MONEY_SCALE),
    igvAmount: formatScaled(taxCents, MONEY_SCALE),
    totalAmount: formatScaled(grossCents, MONEY_SCALE),
    unitValue: formatScaled(unitNet, INPUT_SCALE),
  };
}

export function addMoney(values: string[]): string {
  const total = values.reduce((sum, value) => sum + parseDecimal(value, MONEY_SCALE), 0n);
  return formatScaled(total, MONEY_SCALE);
}

export interface DocumentLineInput extends TaxLineInput {
  productCode?: string;
  description: string;
  unitCode: string;
  taxAffectationCode: string;
}

export function calculateDocumentTotals(lines: DocumentLineInput[]) {
  const calculated = lines.map((line, index) => ({
    lineNumber: index + 1,
    productCode: line.productCode,
    description: line.description,
    unitCode: line.unitCode,
    quantity: line.quantity,
    unitPriceWithTax: line.unitPriceWithTax,
    taxAffectationCode: line.taxAffectationCode,
    igvRate: line.igvRate,
    ...calculateTaxLine(line),
  }));
  return {
    lines: calculated,
    totals: {
      taxableAmount: addMoney(calculated.map((line) => line.lineExtensionAmount)),
      igvAmount: addMoney(calculated.map((line) => line.igvAmount)),
      payableAmount: addMoney(calculated.map((line) => line.totalAmount)),
    },
  };
}
