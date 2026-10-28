/** Presentación, no autoridad fiscal. No contiene credenciales ni modifica UBL. */
export const PRINT_PRESENTATION_VERSION = 'factuez.print-presentation.v1' as const;
export const PRINT_SETTINGS_VERSION = 'factuez.print-settings.v1' as const;
export const PRINT_TEMPLATE = 'SAN_JOSE_V1' as const;
export type PrintableDocumentTypeCode = '01' | '03' | '07' | '08' | '09' | '31';
export type DocumentPrintFormat = 'a4' | 'ticket';
export const PRINT_DOCUMENT_LABELS: Record<PrintableDocumentTypeCode, string> = {
  '01': 'Factura electrónica', '03': 'Boleta de venta electrónica',
  '07': 'Nota de crédito electrónica', '08': 'Nota de débito electrónica',
  '09': 'Guía de remisión remitente', '31': 'Guía de remisión transportista',
};
export interface PrintBrandingSettings {
  template: typeof PRINT_TEMPLATE;
  logoMode: 'DEFAULT' | 'CUSTOM' | 'NONE';
  logoWidthMm: number;
  logoAlignment: 'LEFT' | 'CENTER';
  showBranchAddress: boolean;
  /** Texto comercial opcional; nunca reemplaza crédito, QR ni advertencia de prueba. */
  footerNote: string;
}
export const DEFAULT_PRINT_BRANDING: Readonly<PrintBrandingSettings> = {
  template: PRINT_TEMPLATE, logoMode: 'DEFAULT', logoWidthMm: 40,
  logoAlignment: 'LEFT', showBranchAddress: true, footerNote: '',
};
export interface PrintLogoSnapshot {
  mediaType: 'image/png';
  base64: string;
  sha256: string;
  width: number;
  height: number;
}
export interface FrozenPrintPresentationV1 {
  version: typeof PRINT_PRESENTATION_VERSION;
  issuerRuc: string;
  branchId: string | null;
  /** Revisión de la configuración efectivamente usada; 0 = predeterminada. */
  profileRevision: number;
  settings: PrintBrandingSettings;
  /** PNG normalizado, acotado y congelado. Ninguna URL ni ruta aportada por el cliente. */
  logo: PrintLogoSnapshot | null;
  branchName?: string;
  branchAddress?: string;
}
export interface PrintLogoUpload {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}
export interface PrintBrandingDraft {
  /** null elimina la configuración propia y vuelve a heredar, sin borrar archivos. */
  settings: PrintBrandingSettings | null;
  logoUpload?: PrintLogoUpload;
}
export interface PrintSettingsResponseV1 {
  version: typeof PRINT_SETTINGS_VERSION;
  companyId: number;
  ruc: string;
  branchId: string | null;
  revision: number;
  updatedAt: string | null;
  override: PrintBrandingSettings | null;
  effective: PrintBrandingSettings;
  source: 'BRANCH' | 'ISSUER' | 'DEFAULT';
  logoPreviewDataUrl: string | null;
  storageReady: boolean;
  fiscalTransmission: false;
}
export interface SavePrintSettingsRequest extends PrintBrandingDraft {
  expectedRevision: number;
}
export interface PrintPreviewRequest {
  documentTypeCode: PrintableDocumentTypeCode;
  format: DocumentPrintFormat;
  draft?: PrintBrandingDraft;
}
/** Datos opcionales congelados de impresión; no se obtienen de valores actuales. */
export interface PrintOperationSnapshot {
  branchName?: string;
  branchAddress?: string;
  emissionPointName?: string;
  vehiclePlate?: string;
  attendedBy?: string;
  shiftLabel?: string;
  observations?: string;
  amountInWords?: string;
  purchaseOrder?: string;
  scopNumber?: string;
  relatedGuide?: string;
  odometer?: string;
}
/** Indicadores congelados de la guía. La ausencia no equivale a una declaración NO. */
export interface PrintableTransportIndicators {
  categoryM1L?: boolean;
  returnWithEmptyPackaging?: boolean;
  scheduledTransshipment?: boolean;
  emptyVehicleReturn?: boolean;
  totalTransfer?: boolean;
  subcontracted?: boolean;
  freightPayer?: 'SENDER' | 'RECIPIENT' | 'OTHER';
}
export interface PrintableTransportGuide {
  documentTypeCode: '09' | '31';
  fullNumber: string;
  issueDate: string;
  transferDate: string;
  issuer: { identityNumber: string; legalName: string; tradeName?: string; address?: string; mtcRegistration?: string };
  sender?: { identityNumber: string; legalName: string; address?: string };
  recipient?: { identityNumber: string; legalName: string; address?: string };
  origin: { address: string; ubigeo: string; establishmentCode?: string };
  destination: { address: string; ubigeo: string; establishmentCode?: string };
  transferReason?: { code: string; description: string };
  transportModeCode: '01' | '02';
  grossWeight: string;
  weightUnit: string;
  packageCount?: string;
  transportIndicators?: PrintableTransportIndicators;
  carrier?: { identityNumber: string; legalName: string; mtcRegistration?: string };
  vehicles?: { plate: string; circulationCard?: string }[];
  drivers?: { identityNumber: string; legalName: string; license: string }[];
  relatedDocuments?: { documentTypeCode: string; fullNumber: string; issuerRuc?: string }[];
  observations?: string;
  items: { code?: string; description: string; quantity: string; unitCode: string }[];
  branchId?: string;
  printPresentation?: FrozenPrintPresentationV1;
}
