/** Administración privada de maestros. No es un contrato de emisión fiscal. */
export const STATION_ADMIN_VERSION = 'factuez.station-admin.v1' as const;
export type StationSeriesType = 'INVOICE' | 'SALES_RECEIPT' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'DESPATCH_ADVICE';
export interface StationIssuer {
  id: number; ruc: string; legalName: string; tradeName: string | null;
  taxAddress: string; ubigeo: string; phone: string | null; contactEmails: string[];
  environment: 'BETA' | 'PRODUCTION'; active: boolean; revision: number;
}
export interface StationBranch {
  id: string; companyId: number; code: string; name: string; address: string | null; establishmentCode: string | null;
  active: boolean; effectiveActive: boolean; revision: number; pointCount: number; openShiftCount: number;
}
export interface StationPoint {
  id: string; companyId: number; branchId: string | null; code: string; name: string;
  address: string | null; trackNumber: number | null; active: boolean; effectiveActive: boolean;
  revision: number; openShiftCount: number;
}
export interface StationSeries {
  id: string; companyId: number; emissionPointId: string; documentType: StationSeriesType;
  series: string; nextNumber: string; active: boolean; effectiveActive: boolean;
  revision: number; documentCount: number; canRename: boolean;
}
export interface StationAdminCatalog {
  version: typeof STATION_ADMIN_VERSION;
  capabilities: { betaOnly: boolean; softDelete: true; counterEditing: false };
  companies: StationIssuer[]; branches: StationBranch[];
  emissionPoints: StationPoint[]; series: StationSeries[];
}
export interface StationIssuerDraft {
  ruc: string; legalName: string; taxAddress: string; ubigeo: string;
  tradeName?: string | null; phone?: string | null; contactEmails?: string[];
}
export interface StationBranchDraft { companyId: number; code: string; name: string; address?: string | null; establishmentCode?: string | null }
export interface StationPointDraft {
  code: string; name: string; address?: string | null; trackNumber?: number | null;
  invoiceSeries: string; receiptSeries: string;
}
export interface StationSeriesDraft { documentType: StationSeriesType; series: string }
export interface StationRevision { expectedRevision: number }
export type StationIssuerPatch = StationRevision & Partial<Omit<StationIssuerDraft, 'ruc'>> & { active?: boolean };
export type StationBranchPatch = StationRevision & Partial<Omit<StationBranchDraft, 'companyId'>> & { active?: boolean };
export type StationPointPatch = StationRevision & Partial<Omit<StationPointDraft, 'invoiceSeries' | 'receiptSeries'>> & { active?: boolean };
export type StationSeriesPatch = StationRevision & { series?: string; active?: boolean };
