import type { SirePurchase } from './sire-client';
import { parseSirePurchases, SIRE_RCE_HEADERS } from './sire-parser';
import { sireEnsure, validateSireContext } from './sire-safety';

/** Synthetic only. Never substitute fixtures automatically for a failed/live read. */
export function fixtureSirePurchases(ruc: string, period: string): SirePurchase[] {
  validateSireContext(ruc, period); sireEnsure(ruc.startsWith('00'), 'INPUT');
  const values = [
    ruc, 'RECEPTOR FICTICIO', period, `0000000000201FZ01${period.padStart(10, '0')}`,
    `01/${period.slice(4)}/${period.slice(0, 4)}`, '', '01', 'FZ01', '', period, '',
    '6', '00000000002', 'PROVEEDOR FICTICIO', '100.00', '18.00', '0.00', '0.00',
    '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '118.00', 'PEN',
  ];
  return parseSirePurchases(Buffer.from(`${SIRE_RCE_HEADERS.join('|')}|\n${values.join('|')}|\n`), ruc, period);
}
