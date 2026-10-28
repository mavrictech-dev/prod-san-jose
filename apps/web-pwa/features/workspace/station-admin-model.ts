import type { StationAdminCatalog, StationSeriesType } from '@factuez/contracts';
import type { User } from './types';

export const seriesLabels: Record<StationSeriesType, string> = {
  INVOICE: 'Factura · 01', SALES_RECEIPT: 'Boleta · 03', CREDIT_NOTE: 'Nota de crédito · 07',
  DEBIT_NOTE: 'Nota de débito · 08', DESPATCH_ADVICE: 'Guía remitente · 09',
};
export type MasterKind = 'issuer' | 'branch' | 'point' | 'series' | 'assign';
export type MasterDialog = {
  kind: MasterKind; mode: 'create' | 'edit' | 'deactivate' | 'reactivate';
  targetId?: string; parentId?: string; revision?: number; title?: string; canRename?: boolean;
};
export type MasterDraft = {
  companyId: string; ruc: string; legalName: string; tradeName: string; taxAddress: string; ubigeo: string;
  phone: string; contactEmails: string; code: string; name: string; address: string; establishmentCode: string; trackNumber: string;
  invoiceSeries: string; receiptSeries: string; documentType: StationSeriesType; series: string;
};
export const emptyMasterDraft: MasterDraft = {
  companyId: '', ruc: '', legalName: '', tradeName: '', taxAddress: '', ubigeo: '', phone: '', contactEmails: '',
  code: '', name: '', address: '', establishmentCode: '', trackNumber: '', invoiceSeries: '', receiptSeries: '', documentType: 'INVOICE', series: '',
};
export function canAdminMasters(user: User | undefined) {
  return !!user && user.scope?.kind === 'GLOBAL' && !!user.roles?.includes('ADMIN') && !!user.permissions?.includes('setup.manage');
}
export function parseMasterEmails(value: string) { return [...new Set(value.split(/[;,\n]/).map(email => email.trim()).filter(Boolean))]; }
export function masterSeriesValid(value: string, type: StationSeriesType) {
  const pattern = type === 'INVOICE' ? /^F[A-Z0-9]{3}$/ : type === 'SALES_RECEIPT' ? /^B[A-Z0-9]{3}$/
    : type === 'DESPATCH_ADVICE' ? /^T[A-Z0-9]{3}$/ : /^[FB][A-Z0-9]{3}$/;
  return pattern.test(value.trim().toUpperCase());
}
export function masterDraftError(dialog: MasterDialog, draft: MasterDraft): string | undefined {
  if (dialog.mode === 'deactivate' || dialog.mode === 'reactivate') return;
  if (dialog.kind === 'issuer') {
    if (!/^\d{11}$/.test(draft.ruc)) return 'Indica un RUC de 11 dígitos.';
    if (!draft.legalName.trim() || !draft.taxAddress.trim() || !/^\d{6}$/.test(draft.ubigeo)) return 'Completa razón social, dirección fiscal y ubigeo de 6 dígitos.';
    const emails = parseMasterEmails(draft.contactEmails);
    if (emails.length > 10 || emails.some(email => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return 'Usa hasta 10 correos válidos, separados por coma o punto y coma.';
  }
  if (dialog.kind === 'branch' && dialog.mode === 'create' || dialog.kind === 'assign') {
    if (!/^[1-9]\d*$/.test(draft.companyId)) return 'Selecciona un emisor activo.';
  }
  if (dialog.kind === 'branch' || dialog.kind === 'point') {
    if (!/^[A-Z0-9_-]{2,20}$/.test(draft.code.trim().toUpperCase()) || !draft.name.trim()) return 'Indica un código válido y un nombre.';
    if (dialog.kind === 'branch' && draft.establishmentCode !== '' && (draft.establishmentCode.length !== 4 || !/^[0-9]{4}$/.test(draft.establishmentCode))) return 'El establecimiento SUNAT debe tener exactamente 4 dígitos o quedar vacío.';
    if (dialog.kind === 'point' && draft.trackNumber && (!/^\d{1,4}$/.test(draft.trackNumber) || Number(draft.trackNumber) < 1)) return 'La pista debe estar entre 1 y 9999 o quedar vacía.';
    if (dialog.kind === 'point' && dialog.mode === 'create' && (!masterSeriesValid(draft.invoiceSeries, 'INVOICE') || !masterSeriesValid(draft.receiptSeries, 'SALES_RECEIPT'))) return 'Las series iniciales requieren F + 3 caracteres y B + 3 caracteres.';
  }
  if (dialog.kind === 'series' && !masterSeriesValid(draft.series, draft.documentType)) return 'Usa una serie de 4 caracteres con el prefijo del tipo de documento.';
}
export function masterCommand(dialog: MasterDialog, draft: MasterDraft) {
  const base = '/api/v1/stations';
  const path = dialog.kind === 'issuer' ? `${base}/issuers${dialog.targetId ? `/${dialog.targetId}` : ''}`
    : dialog.kind === 'point' ? dialog.mode === 'create' ? `${base}/${dialog.parentId}/points` : `${base}/points/${dialog.targetId}`
    : dialog.kind === 'series' ? dialog.mode === 'create' ? `${base}/points/${dialog.parentId}/series` : `${base}/series/${dialog.targetId}`
    : dialog.kind === 'assign' ? `${base}/${dialog.targetId}/issuer` : `${base}${dialog.targetId ? `/${dialog.targetId}` : ''}`;
  const rev = { expectedRevision: dialog.revision };
  if (dialog.mode === 'deactivate') return { path, method: 'DELETE', body: rev };
  if (dialog.mode === 'reactivate') return { path, method: 'PATCH', body: { ...rev, active: true } };
  const creation = dialog.mode === 'create';
  const values = dialog.kind === 'issuer' ? {
    ...(creation ? { ruc: draft.ruc } : {}), legalName: draft.legalName.trim(), tradeName: draft.tradeName.trim() || null,
    taxAddress: draft.taxAddress.trim(), ubigeo: draft.ubigeo, phone: draft.phone.trim() || null, contactEmails: parseMasterEmails(draft.contactEmails),
  } : dialog.kind === 'assign' ? { companyId: Number(draft.companyId) }
    : dialog.kind === 'series' ? { ...(creation ? { documentType: draft.documentType } : {}), series: draft.series.trim().toUpperCase() }
    : { ...(dialog.kind === 'branch' && creation ? { companyId: Number(draft.companyId) } : {}), code: draft.code.trim().toUpperCase(), name: draft.name.trim(), address: draft.address.trim() || null,
      ...(dialog.kind === 'branch' ? { establishmentCode: draft.establishmentCode || null } : {}),
      ...(dialog.kind === 'point' ? { trackNumber: draft.trackNumber ? Number(draft.trackNumber) : null,
        ...(creation ? { invoiceSeries: draft.invoiceSeries.trim().toUpperCase(), receiptSeries: draft.receiptSeries.trim().toUpperCase() } : {}) } : {}) };
  return { path, method: creation ? 'POST' : 'PATCH', body: { ...(!creation ? rev : {}), ...values } };
}
export function masterDraftFor(dialog: MasterDialog, catalog: StationAdminCatalog): MasterDraft {
  const draft = { ...emptyMasterDraft };
  if (dialog.mode === 'create') return draft;
  if (dialog.kind === 'issuer') {
    const row = catalog.companies.find(c => String(c.id) === dialog.targetId);
    if (row) Object.assign(draft, row, { tradeName: row.tradeName ?? '', phone: row.phone ?? '', contactEmails: row.contactEmails.join(', ') });
  } else if (dialog.kind === 'branch' || dialog.kind === 'assign') {
    const row = catalog.branches.find(b => b.id === dialog.targetId);
    if (row) Object.assign(draft, { companyId: String(row.companyId), code: row.code, name: row.name, address: row.address ?? '', establishmentCode: row.establishmentCode ?? '' });
  } else if (dialog.kind === 'point') {
    const row = catalog.emissionPoints.find(p => p.id === dialog.targetId);
    if (row) Object.assign(draft, { code: row.code, name: row.name, address: row.address ?? '', trackNumber: row.trackNumber === null ? '' : String(row.trackNumber) });
  } else {
    const row = catalog.series.find(s => s.id === dialog.targetId);
    if (row) Object.assign(draft, { documentType: row.documentType, series: row.series });
  }
  return draft;
}
