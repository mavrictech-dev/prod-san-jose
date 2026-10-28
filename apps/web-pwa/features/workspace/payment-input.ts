import type { FiscalPaymentTermsSnapshot } from '@factuez/contracts';
// Entrada apta para navegador: el barrel también exporta crypto exclusivo Node.
import { validateInvoicePaymentTerms } from '@factuez/sunat-core/dist/fiscal-rules';
export type PaymentDraft = { type: 'CONTADO' | 'CREDITO'; pendingAmount: string; installments: { amount: string; dueDate: string }[] };
export const initialPayment = (): PaymentDraft => ({ type: 'CONTADO', pendingAmount: '', installments: [{ amount: '', dueDate: '' }] });
export function paymentTermsFor(draft: PaymentDraft): FiscalPaymentTermsSnapshot {
  return draft.type === 'CONTADO' ? { type: 'CONTADO' } : { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: draft.pendingAmount,
    installments: draft.installments.map(row => ({ amount: row.amount, dueDate: row.dueDate })) };
}
export function paymentDraftError(draft: PaymentDraft, documentType: string, payableAmount: string | undefined, now = new Date()) {
  if (!payableAmount) return undefined;
  return validateInvoicePaymentTerms({ documentTypeCode: documentType === 'INVOICE' ? '01' : '03',
    paymentTerms: paymentTermsFor(draft), currencyCode: 'PEN', totals: { payableAmount }, issueDate: now.toISOString() },
    { mode: 'REAL_PREPARATION' })[0]?.message;
}
